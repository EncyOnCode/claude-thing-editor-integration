#!/usr/bin/env node
// Minimal-edit patcher for Thing-Editor scene/prefab JSON.
// Preserves key order, indent style (tabs detected). Only touches keys in patch.
//
// Refuse rules (see references/coord-mapping.md "Patcher refuse matrix"):
//   - scale.x / scale.y on Text-class self OR Text descendant
//   - x / y / pivot.x / pivot.y when overwritten by recalculateCoordinates() or LayoutGroup
//   - width / height when overwritten by stretchAnchor / LayoutGroup sizeMode / dynamicSize
//
// Usage: node apply-patch.mjs <scene.json> <patch.json> [--dry] [--force]
//
// patch.json schema:
// [
//   { "scenePath": [":", 0, ":", 2], "prop": "x", "to": 120 },
//   { "scenePath": [...], "prop": "scale.x", "to": 1.05 }
// ]
//
// scenePath = array from scene-walker output (path field). Points at the NODE (with c/p/:), not into p.
// "prop" supports dot notation (e.g. "scale.x"); matches existing JSON key form.
//
// --force overrides all refuse guards. Use only if you know what you're doing.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extendTokens, isLayoutManaged, isTextClass as registryIsTextClass } from './shared/class-tokens.mjs';
import { loadRegistry } from './shared/project-class-registry.mjs';

const TEXT_CLASS_RE = /(^|[^A-Za-z])(Text|BitmapText|HTMLText)([^A-Za-z]|$)/;
const SCALE_PROPS = new Set(['scale.x', 'scale.y', 'scale']);
const POSITION_PROPS = new Set(['x', 'y']);
const PIVOT_PROPS = new Set(['pivot.x', 'pivot.y']);
const SIZE_PROPS = new Set(['width', 'height']);
const OVERRIDING_SIZE_MODES = new Set(['both', 'stretch', 'shrink']);

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const projectIdx = args.indexOf('--project');
const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--project');
const [scenePath, patchPath] = positional;
const dry = flags.has('--dry');
const force = flags.has('--force');

if (!scenePath || !patchPath) {
	console.error('usage: apply-patch.mjs <scene.json> <patch.json> [--dry] [--force] [--project <root>]');
	process.exit(1);
}

// Optional registry — extends isLayoutManaged() and isTextClass() so refuse
// rules catch custom LayoutGroup/Resizer/Text subclasses (e.g. AnimatedLayoutGroup
// extends LayoutGroup extends Shape) that the hardcoded sets miss. Also drives
// Phase 5 strict prop-type validation when classes carry __editableProps from
// engine truth.
let registry = null;
if (projectRoot) {
	try {
		registry = loadRegistry(projectRoot);
		extendTokens(registry);
	} catch (e) {
		console.error(`warn: failed to load class registry from ${projectRoot}: ${e.message}`);
	}
}

// Engine-truth detection — strict type validation only fires when the registry
// came from `.thing-editor-meta/classes.json`. Regex-only registries lack
// __editableProps and degrade to TYPE_CHECK_SKIPPED.
const registryIsEngineTruth = !!(
	registry &&
	(registry.version === 'engine-1' ||
		Object.values(registry.classes || {}).some(c => Array.isArray(c.__editableProps)))
);

// Strict type-validation rules (Phase 5). Editor-only types reject because the
// AI must not blindly land refs / data-paths / callbacks / prefab refs into a
// scene without dedicated tooling. `btn`/`splitter` are non-data render hooks.
const UNSAFE_TYPES = new Set(['ref', 'data-path', 'callback', 'prefab']);
const NON_DATA_TYPES = new Set(['btn', 'splitter']);

// Runtime PIXI properties — present on every DisplayObject/Container regardless
// of whether the class declares them with `@editable`. Patching them is always
// safe at the type level (engine still respects refuse-matrix elsewhere). We
// fall back to JS typeof checks instead of __editableProps for these.
const RUNTIME_PIXI_PROPS = {
	x: 'number',
	y: 'number',
	alpha: 'number',
	rotation: 'number',
	tint: 'color',
	visible: 'boolean',
	'scale.x': 'number',
	'scale.y': 'number',
	'pivot.x': 'number',
	'pivot.y': 'number',
	'skew.x': 'number',
	'skew.y': 'number',
	width: 'number',
	height: 'number',
	// Resizer/canOverride alternatives — written by Phase 2A diff path. They're
	// engine-side @editable on Container, but custom classes that don't extend
	// Container directly may not surface them. Whitelist as numbers.
	normalizePosX: 'number',
	normalizePosY: 'number',
	normAnchorX: 'number',
	normAnchorY: 'number',
	normPivotX: 'number',
	normPivotY: 'number'
};

function validatePropType(classInfo, prop, value) {
	if (!classInfo || !Array.isArray(classInfo.__editableProps) || classInfo.__editableProps.length === 0) {
		return { ok: true, skip: true };
	}
	const propDef = classInfo.__editableProps.find(p => p.name === prop);
	if (!propDef) {
		// Runtime PIXI prop fallback — class doesn't list it in __editableProps
		// but it's valid on every DisplayObject.
		const fallbackType = RUNTIME_PIXI_PROPS[prop];
		if (fallbackType) {
			return validateTypedValue(fallbackType, prop, value, null, null);
		}
		return { ok: false, code: 'UNKNOWN_PROP', reason: `class "${classInfo.chain?.[0] || '?'}" has no editable prop "${prop}"` };
	}
	const t = propDef.type;
	if (UNSAFE_TYPES.has(t)) {
		return { ok: false, code: 'UNSAFE_TYPE', reason: `prop "${prop}" is type "${t}" — refusing to land via AI patch` };
	}
	if (NON_DATA_TYPES.has(t)) {
		return { ok: false, code: 'NON_DATA', reason: `prop "${prop}" is type "${t}" (UI-only, not serializable)` };
	}
	return validateTypedValue(t, prop, value, propDef.min, propDef.max);
}

function validateTypedValue(t, prop, value, min, max) {
	switch (t) {
		case 'number':
		case 'slider': {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { ok: false, code: 'TYPE_MISMATCH', reason: `prop "${prop}" expects number, got ${typeof value} (${JSON.stringify(value)})` };
			}
			if (typeof min === 'number' && value < min) {
				return { ok: false, code: 'OUT_OF_RANGE', reason: `prop "${prop}" value ${value} < min ${min}` };
			}
			if (typeof max === 'number' && value > max) {
				return { ok: false, code: 'OUT_OF_RANGE', reason: `prop "${prop}" value ${value} > max ${max}` };
			}
			return { ok: true };
		}
		case 'string':
		case 'l10n':
		case 'image':
		case 'sound':
		case 'resource':
		case 'spine-sequence':
		case 'pow-damp-preset':
			if (typeof value !== 'string') {
				return { ok: false, code: 'TYPE_MISMATCH', reason: `prop "${prop}" expects string (type "${t}"), got ${typeof value}` };
			}
			return { ok: true };
		case 'boolean':
			if (typeof value !== 'boolean') {
				return { ok: false, code: 'TYPE_MISMATCH', reason: `prop "${prop}" expects boolean, got ${typeof value}` };
			}
			return { ok: true };
		case 'color': {
			if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xFFFFFF) {
				return { ok: false, code: 'TYPE_MISMATCH', reason: `prop "${prop}" expects color integer 0..0xFFFFFF, got ${JSON.stringify(value)}` };
			}
			return { ok: true };
		}
		case 'rect':
		case 'timeline':
		case 'curve':
			if (value === null || typeof value !== 'object') {
				return { ok: false, code: 'TYPE_MISMATCH', reason: `prop "${prop}" expects object (type "${t}"), got ${typeof value}` };
			}
			return { ok: true };
		default:
			// Forward-compat: engine added a new type we don't know. Per plan §5
			// strict mode rejects unknown types so we don't silently land garbage;
			// flip to `{ ok: true }` to make this permissive.
			return { ok: false, code: 'UNKNOWN_TYPE', reason: `prop "${prop}" has unhandled type "${t}"` };
	}
}

const sceneAbs = resolve(scenePath);
const raw = readFileSync(sceneAbs, 'utf8');
const indent = raw.includes('\n\t') ? '\t' : '  ';
const scene = JSON.parse(raw);
const patches = JSON.parse(readFileSync(resolve(patchPath), 'utf8'));

let applied = 0;
let skipped = 0;
let refused = 0;
let typeRejected = 0;
let typeSkipped = 0;
const log = [];
const rejected = []; // strict type-validation rejections (separate from refused)

for (const entry of patches) {
	const ctx = locateWithParent(scene, entry.scenePath);
	if (!ctx) {
		log.push(`SKIP missing-node ${fmtPath(entry.scenePath)} ${entry.prop}`);
		skipped++;
		continue;
	}
	const { node, parent } = ctx;

	if (!force) {
		const guard = guardPatch(entry.prop, node, parent);
		if (guard.blocked) {
			log.push(`REFUSE ${guard.code} ${fmtPath(entry.scenePath)} ${entry.prop} -> ${JSON.stringify(entry.to)}  (reason: ${guard.reason})`);
			if (guard.hint) log.push(`       Hint: ${guard.hint}`);
			refused++;
			continue;
		}
	}

	// Strict type validation — only when engine truth is available. Always runs
	// (even under --force): force is for refuse-matrix overrides, not for
	// landing a wrong-typed value.
	if (registryIsEngineTruth) {
		const classInfo = registry?.classes?.[node.c];
		const tc = validatePropType(classInfo, entry.prop, entry.to);
		if (!tc.ok) {
			log.push(`REJECT ${tc.code} ${fmtPath(entry.scenePath)} ${entry.prop} -> ${JSON.stringify(entry.to)}  (reason: ${tc.reason})`);
			rejected.push({
				scenePath: entry.scenePath,
				prop: entry.prop,
				value: entry.to,
				code: tc.code,
				reason: tc.reason
			});
			typeRejected++;
			continue;
		}
		if (tc.skip) typeSkipped++;
	} else {
		typeSkipped++;
	}

	if (!node.p) node.p = {};
	const before = node.p[entry.prop];
	node.p[entry.prop] = entry.to;
	log.push(`SET ${fmtPath(entry.scenePath)} ${entry.prop} ${JSON.stringify(before)} -> ${JSON.stringify(entry.to)}`);
	applied++;
}

const serialized = JSON.stringify(scene, null, indent) + '\n';

function summary(prefix) {
	const parts = [`${applied} ${prefix}`, `${refused} refused`, `${typeRejected} type-rejected`, `${skipped} skipped`];
	if (typeSkipped > 0 && !registryIsEngineTruth) {
		parts.push(`TYPE_CHECK_SKIPPED (no engine classes.json — run "Project → Export Figma-Sync metadata")`);
	}
	return parts.join(', ');
}

if (rejected.length > 0) {
	console.log('\nTYPE_VALIDATION_REJECTED summary:');
	for (const r of rejected) console.log(`  ${r.code}  ${fmtPath(r.scenePath)}.${r.prop} = ${JSON.stringify(r.value)} — ${r.reason}`);
}

if (dry) {
	console.log(log.join('\n'));
	console.log(`\nDRY: ${summary('would apply')}`);
} else {
	if ((refused > 0 || typeRejected > 0) && !force) {
		console.log(log.join('\n'));
		const blockers = [];
		if (refused > 0) blockers.push(`${refused} refused`);
		if (typeRejected > 0) blockers.push(`${typeRejected} type-rejected`);
		console.log(`\nABORT: ${blockers.join(', ')}. Re-run with --force to override refuse-matrix (does NOT override type validation), or change patch.`);
		process.exit(2);
	}
	writeFileSync(sceneAbs, serialized);
	console.log(log.join('\n'));
	console.log(`\nWROTE ${sceneAbs}: ${summary('applied')}`);
}

// --- locate with parent ---

function locateWithParent(root, path) {
	let cur = root;
	let parent = null;
	for (let i = 0; i < path.length; i++) {
		if (cur == null) return null;
		if (path[i] === ':' && i + 1 < path.length && typeof path[i + 1] === 'number') {
			parent = cur;
			const arr = cur[':'];
			if (!arr) return null;
			cur = arr[path[i + 1]];
			i++;
		} else {
			cur = cur[path[i]];
		}
	}
	if (!cur) return null;
	return { node: cur, parent };
}

function fmtPath(p) {
	return p.length === 0 ? '<root>' : p.join('.');
}

function isTextClass(cls) {
	if (!cls) return false;
	// Registry-aware (catches custom subclasses of Text/BitmapText/HTMLText) with
	// regex fallback for callers running without --project.
	if (registryIsTextClass(cls)) return true;
	return TEXT_CLASS_RE.test(cls);
}

// Main guard dispatcher. Returns { blocked, code, reason, hint }.
function guardPatch(prop, node, parent) {
	if (SCALE_PROPS.has(prop)) return guardScale(node);
	if (POSITION_PROPS.has(prop)) return guardPosition(prop, node, parent);
	if (PIVOT_PROPS.has(prop)) return guardPivot(prop, node);
	if (SIZE_PROPS.has(prop)) return guardSize(prop, node, parent);
	return { blocked: false };
}

// scale.x / scale.y guard — refuse if self or descendant is Text-class.
function guardScale(node) {
	if (isTextClass(node.c)) {
		return {
			blocked: true,
			code: 'scale-on-text',
			reason: `node class "${node.c}" is Text`,
			hint: 'patch style.fontSize instead'
		};
	}
	const found = findTextDescendant(node);
	if (found) {
		return {
			blocked: true,
			code: 'scale-on-text-ancestor',
			reason: `descendant "${found.path}" is class "${found.cls}"`,
			hint: 'keep this node\'s scale=1; patch each Text leaf\'s style.fontSize and adjust other children\'s x/y to compensate'
		};
	}
	return { blocked: false };
}

// x/y guard — refuse if engine overwrites position.
function guardPosition(prop, node, parent) {
	const parentClass = parent?.c ?? null;
	if (parentClass && isLayoutManaged(parentClass)) {
		return {
			blocked: true,
			code: 'layout-managed-position',
			reason: `parent class "${parentClass}" overwrites child ${prop} in layoutChildren()`,
			hint: `change parent's spacingX/spacingY/padding*/aligmentX/aligmentY/orientation, or reorder children — see coord-mapping.md`
		};
	}
	const p = node.p ?? {};
	if (p.canOverridePivotAndAnchor === true) {
		const replacement = prop === 'x' ? 'normalizePosX' : 'normalizePosY';
		const altAnchor = prop === 'x' ? 'normAnchorX' : 'normAnchorY';
		return {
			blocked: true,
			code: 'recalc-position',
			reason: `canOverridePivotAndAnchor=true → recalculateCoordinates() overwrites position.${prop} every resize`,
			hint: `patch "${replacement}" (pixel offset) or "${altAnchor}" (0..1 fraction of parent ${prop === 'x' ? 'width' : 'height'}). Engine formula: targetX = parentW × normAnchorX + normalizePosX`
		};
	}
	return { blocked: false };
}

// pivot.x / pivot.y guard — refuse if canOverridePivotAndAnchor=true (pivot always overwritten).
function guardPivot(prop, node) {
	const p = node.p ?? {};
	if (p.canOverridePivotAndAnchor === true) {
		const replacement = prop === 'pivot.x' ? 'normPivotX' : 'normPivotY';
		const dim = prop === 'pivot.x' ? 'width' : 'height';
		return {
			blocked: true,
			code: 'recalc-pivot',
			reason: `canOverridePivotAndAnchor=true → pivot is always recomputed as ${dim} × ${replacement}`,
			hint: `patch "${replacement}" (0..1 fraction of own ${dim})`
		};
	}
	return { blocked: false };
}

// width / height guard — refuse if stretch / layout-sizeMode / dynamicSize overrides.
function guardSize(prop, node, parent) {
	const p = node.p ?? {};
	const axis = prop === 'width' ? 'X' : 'Y';
	const stretch = Number(p['stretchAnchor' + axis]) || 0;
	if (stretch > 0) {
		return {
			blocked: true,
			code: 'stretch-overrides-size',
			reason: `stretchAnchor${axis}=${stretch} → engine computes ${prop} = parent${prop} × stretchAnchor${axis} − margins`,
			hint: `patch "stretchAnchor${axis}" or margin${axis === 'X' ? 'Left/Right' : 'Top/Bottom'} instead`
		};
	}

	// self is LayoutGroup with dynamicSize matching this axis
	const selfClass = node.c;
	if (selfClass === 'LayoutGroup' && p.dynamicSize === true) {
		const orient = p.orientation || 'Horizontal';
		if ((orient === 'Horizontal' && prop === 'width') || (orient === 'Vertical' && prop === 'height')) {
			return {
				blocked: true,
				code: 'layout-dynamic-size',
				reason: `LayoutGroup with dynamicSize=true & orientation="${orient}" auto-computes ${prop} from children`,
				hint: `adjust children sizes/spacing/padding instead`
			};
		}
	}

	// parent LayoutGroup sizeMode forces this axis on child
	const parentClass = parent?.c;
	if (parentClass === 'LayoutGroup') {
		const sizeMode = parent.p?.[prop === 'width' ? 'sizeModeH' : 'sizeModeV'] || 'none';
		if (OVERRIDING_SIZE_MODES.has(sizeMode)) {
			return {
				blocked: true,
				code: 'layout-size-mode',
				reason: `parent LayoutGroup sizeMode${prop === 'width' ? 'H' : 'V'}="${sizeMode}" overrides child ${prop}`,
				hint: `change parent's sizeMode${prop === 'width' ? 'H' : 'V'} or width/height; or adjust siblings`
			};
		}
	}

	return { blocked: false };
}

function findTextDescendant(node, trail = []) {
	const children = node[':'] ?? [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		const childTrail = [...trail, ':', i];
		if (isTextClass(child.c)) {
			const name = child.p?.name;
			return { path: name ? `${name} (${childTrail.join('.')})` : childTrail.join('.'), cls: child.c };
		}
		const deeper = findTextDescendant(child, childTrail);
		if (deeper) return deeper;
	}
	return null;
}
