// Pattern A (soft) Design System helpers.
//
// Plugin-only. Detects Figma variables (color tokens, text styles, font sizes)
// and surfaces hints in the diff report. No engine-side resolution yet — the
// engine still receives raw-value patches; this module only powers warnings
// and the `figma.tokens.json` mapping config that a later phase will consume.
//
// Exports:
//   loadFigmaTokensConfig(projectRoot)
//   loadFigmaVariables(path)
//   resolveBoundVariable(layer, variables, modeId?)
//   findEngineMappingFor(tokensConfig, figmaVariableName)
//   normalizeHex(value)

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TOKENS_CONFIG_FILENAME = 'figma.tokens.json';

// --- public API ---

export function loadFigmaTokensConfig(projectRoot) {
	if (!projectRoot) return null;
	const p = join(resolve(projectRoot), TOKENS_CONFIG_FILENAME);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, 'utf8'));
		// Normalize: ensure expected sections exist.
		return {
			version: raw.version ?? 1,
			colors: raw.colors || {},
			fontSizes: raw.fontSizes || {},
			textStyles: raw.textStyles || {},
			_path: p
		};
	} catch (e) {
		console.error(`warn: failed to parse ${p}: ${e.message}`);
		return null;
	}
}

// Load a variables JSON produced by fetch-figma-vars.mjs. Accepts both:
//   - "raw" Figma response: { meta: { variables, variableCollections }, ... }
//   - "flattened" form:     { version, collections, variables: [...] }
// Returns a normalized lookup map keyed by variable id:
//   { name, type, valuesByMode, hexValue?, defaultHex?, collectionId?, collectionName? }
export function loadFigmaVariables(path) {
	if (!path) return { byId: {}, byName: {}, collections: [], styles: {} };
	const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
	return normalizeVariables(raw);
}

export function normalizeVariables(raw) {
	const byId = {};
	const byName = {};
	let collections = [];
	const styles = raw.styles || {};

	if (raw && raw.meta && raw.meta.variables) {
		// Raw Figma response shape.
		const colMeta = raw.meta.variableCollections || {};
		collections = Object.values(colMeta).map(c => ({
			id: c.id,
			name: c.name,
			modes: c.modes || [],
			defaultModeId: c.defaultModeId || (c.modes?.[0]?.modeId ?? c.modes?.[0]?.id ?? null)
		}));
		const modeNameById = {};
		for (const c of collections) {
			for (const m of c.modes) modeNameById[m.modeId || m.id] = m.name;
		}
		for (const v of Object.values(raw.meta.variables)) {
			const collection = colMeta[v.variableCollectionId];
			const defaultModeId = collection?.defaultModeId
				|| collection?.modes?.[0]?.modeId
				|| collection?.modes?.[0]?.id
				|| null;
			const valuesByMode = {};
			for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
				valuesByMode[modeId] = { modeName: modeNameById[modeId] || modeId, value: val };
			}
			const entry = {
				id: v.id,
				name: v.name,
				type: v.resolvedType,
				collectionId: v.variableCollectionId,
				collectionName: collection?.name || null,
				defaultModeId,
				valuesByMode
			};
			attachDefaultHex(entry);
			byId[v.id] = entry;
			byName[v.name] = entry;
		}
	} else if (raw && Array.isArray(raw.variables)) {
		// Flattened shape.
		collections = raw.collections || [];
		const colById = {};
		for (const c of collections) colById[c.id] = c;
		for (const v of raw.variables) {
			const valuesByMode = {};
			for (const m of v.values || []) {
				valuesByMode[m.modeId] = { modeName: m.modeName, value: m.value };
			}
			const entry = {
				id: v.id,
				name: v.name,
				type: v.type,
				collectionId: v.collectionId,
				collectionName: colById[v.collectionId]?.name || null,
				defaultModeId: v.defaultModeId || (v.values?.[0]?.modeId ?? null),
				valuesByMode,
				defaultHex: v.defaultHex ?? null
			};
			if (entry.type === 'COLOR' && entry.defaultHex == null) attachDefaultHex(entry);
			byId[v.id] = entry;
			byName[v.name] = entry;
		}
	}

	return { byId, byName, collections, styles };
}

// Given a figma layer's `boundVariables` field (Figma REST response includes
// `{ fills: [{ type: 'VARIABLE_ALIAS', id }], strokes: [...], fontSize: {...} }`
// in many shapes — Figma sometimes returns arrays per-fill, sometimes a single
// object), resolve to a normalized array describing which variables drive the
// layer.
// Returns: [{ field, variableId, variableName?, value?, hex? }]
export function resolveBoundVariable(layer, variables, modeId) {
	const out = [];
	const bound = layer?.boundVariables;
	if (!bound || typeof bound !== 'object') return out;
	const byId = variables?.byId || {};

	for (const [field, refOrList] of Object.entries(bound)) {
		const refs = Array.isArray(refOrList) ? refOrList : [refOrList];
		for (const ref of refs) {
			if (!ref) continue;
			const varId = ref.id || ref.variableId || (typeof ref === 'string' ? ref : null);
			if (!varId) continue;
			const variable = byId[varId];
			const value = pickModeValue(variable, modeId);
			out.push({
				field,
				variableId: varId,
				variableName: variable?.name || null,
				type: variable?.type || null,
				value: value?.value ?? null,
				hex: variable?.type === 'COLOR' ? colorValueToHex(value?.value ?? variable?.defaultHex) : null
			});
		}
	}
	return out;
}

export function findEngineMappingFor(tokensConfig, figmaVariableName) {
	if (!tokensConfig || !figmaVariableName) return null;
	// Try direct lookup in `colors`, `fontSizes`, `textStyles` in that order.
	for (const section of ['colors', 'fontSizes', 'textStyles']) {
		const map = tokensConfig[section];
		if (!map) continue;
		if (map[figmaVariableName]) {
			return { section, name: figmaVariableName, ...map[figmaVariableName] };
		}
		// Try with last segment of slash/group prefixed names (Figma uses
		// `color/primary`, `theme/bg/dark`).
		const last = figmaVariableName.split('/').pop();
		if (last && map[last]) {
			return { section, name: last, ...map[last] };
		}
	}
	return null;
}

// Normalize a fallback string ("0xff5500", "#ff5500", 16732416) to an unsigned
// integer 0xRRGGBB or null.
export function normalizeHex(value) {
	if (value == null) return null;
	if (typeof value === 'number') return value & 0xffffff;
	if (typeof value === 'string') {
		const trimmed = value.trim().replace(/^#/, '').replace(/^0x/i, '');
		if (!/^[0-9a-fA-F]{3,8}$/.test(trimmed)) return null;
		// Accept 6-digit RGB or 8-digit RRGGBBAA (drop alpha).
		const hex = trimmed.length === 3
			? trimmed.split('').map(c => c + c).join('')
			: trimmed.slice(0, 6);
		return parseInt(hex, 16) & 0xffffff;
	}
	if (typeof value === 'object' && value && 'r' in value) {
		return colorValueToHex(value);
	}
	return null;
}

// --- internals ---

function pickModeValue(variable, requestedModeId) {
	if (!variable) return null;
	const modes = variable.valuesByMode || {};
	const modeIds = Object.keys(modes);
	if (modeIds.length === 0) return null;
	if (requestedModeId && modes[requestedModeId]) return modes[requestedModeId];
	if (variable.defaultModeId && modes[variable.defaultModeId]) return modes[variable.defaultModeId];
	return modes[modeIds[0]];
}

function attachDefaultHex(entry) {
	if (entry.type !== 'COLOR') return;
	const v = pickModeValue(entry, null);
	if (!v) return;
	entry.defaultHex = colorValueToHex(v.value);
}

export function colorValueToHex(value) {
	if (!value || typeof value !== 'object') return null;
	if (!('r' in value)) return null;
	const r = Math.round((value.r ?? 0) * 255);
	const g = Math.round((value.g ?? 0) * 255);
	const b = Math.round((value.b ?? 0) * 255);
	return (r << 16) | (g << 8) | b;
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const fake = {
		meta: {
			variableCollections: {
				'col:1': { id: 'col:1', name: 'theme', modes: [{ modeId: 'm:1', name: 'light' }], defaultModeId: 'm:1' }
			},
			variables: {
				'v:1': {
					id: 'v:1',
					name: 'primary-color',
					resolvedType: 'COLOR',
					variableCollectionId: 'col:1',
					valuesByMode: { 'm:1': { r: 1, g: 0.333, b: 0, a: 1 } }
				},
				'v:2': {
					id: 'v:2',
					name: 'h1-size',
					resolvedType: 'FLOAT',
					variableCollectionId: 'col:1',
					valuesByMode: { 'm:1': 32 }
				}
			}
		}
	};
	const vars = normalizeVariables(fake);
	const ok1 = vars.byId['v:1'].defaultHex === 0xff5500;
	console.log(`${ok1 ? 'PASS' : 'FAIL'} color → hex (got 0x${vars.byId['v:1'].defaultHex?.toString(16)})`);

	const resolved = resolveBoundVariable({ boundVariables: { fills: [{ id: 'v:1' }] } }, vars);
	const ok2 = resolved.length === 1 && resolved[0].variableName === 'primary-color' && resolved[0].hex === 0xff5500;
	console.log(`${ok2 ? 'PASS' : 'FAIL'} resolveBoundVariable`);

	const cfg = {
		version: 1,
		colors: { 'primary-color': { engineToken: '$theme.primary', fallback: '0xff5500' } },
		fontSizes: {},
		textStyles: {}
	};
	const mapping = findEngineMappingFor(cfg, 'primary-color');
	const ok3 = mapping?.engineToken === '$theme.primary';
	console.log(`${ok3 ? 'PASS' : 'FAIL'} findEngineMappingFor direct`);

	const mapping2 = findEngineMappingFor(cfg, 'theme/primary-color');
	const ok4 = mapping2?.engineToken === '$theme.primary';
	console.log(`${ok4 ? 'PASS' : 'FAIL'} findEngineMappingFor slash-suffix`);

	const ok5 = normalizeHex('#ff5500') === 0xff5500 && normalizeHex('0xff5500') === 0xff5500 && normalizeHex(0xff5500) === 0xff5500;
	console.log(`${ok5 ? 'PASS' : 'FAIL'} normalizeHex`);

	process.exit(ok1 && ok2 && ok3 && ok4 && ok5 ? 0 : 1);
}
