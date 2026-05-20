// Parse "[Class] name (meta)" Figma layer naming convention.
// Auto-infer class from Figma node type when no tag present.
//
// Exports:
//   parseLayerName(name) → { skip, classTag, identifier, meta, raw, errors: [{code, message}] }
//   inferClass(figmaNode) → { token, confidence, reason } | null
//   parseMeta(metaStr) → { kv: {key: value}, errors: [{code, message}] }

import { resolveToken } from './class-tokens.mjs';

// Layer name grammar:
//   _identifier                      → skipped (design-only)
//   [Class] identifier               → tagged
//   [Class] identifier (k:v, k:v)    → tagged with meta
//   identifier                       → untagged (infer-fallback)

const TAG_RE = /^\[(\w+)\]\s+([A-Za-z][A-Za-z0-9_]*)(?:\s+\((.*)\))?$/;
const SKIP_RE = /^_[A-Za-z0-9_]+/;
const UNTAGGED_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+\((.*)\))?$/;
const INVALID_IDENT_CHARS = /[^A-Za-z0-9_]/;

// Parse meta string like "shape:rect, color:0x444444, radius:8".
// Splits on commas ONLY when followed by another `key:` (lookahead). This preserves
// comma-separated number lists in values like "insets:16,16,16,16".
export function parseMeta(metaStr) {
	const errors = [];
	const kv = {};
	if (!metaStr) return { kv, errors };
	const parts = metaStr.split(/,\s*(?=[A-Za-z][A-Za-z0-9_]*\s*:)/).map(s => s.trim());
	for (const part of parts) {
		const colonIdx = part.indexOf(':');
		if (colonIdx < 0) {
			errors.push({ code: 'M005', message: `meta entry "${part}" missing colon` });
			continue;
		}
		const key = part.slice(0, colonIdx).trim();
		const valRaw = part.slice(colonIdx + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
			errors.push({ code: 'M005', message: `meta key "${key}" invalid` });
			continue;
		}
		kv[key] = parseMetaValue(valRaw);
	}
	return { kv, errors };
}

function parseMetaValue(raw) {
	// hex int: 0xRRGGBB or 0xRRGGBBAA
	if (/^0x[0-9A-Fa-f]+$/.test(raw)) return parseInt(raw, 16);
	// boolean
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	// number with comma-separated values: "16,16,16,16" or "0.5,1"
	if (/^[\d.]+(,[\d.]+)+$/.test(raw)) {
		return raw.split(',').map(Number);
	}
	// plain number
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	// fallback: string
	return raw;
}

// Main entry. Returns:
// {
//   skip: bool,                  // true → ignore this layer entirely
//   classTag: string | null,     // resolved canonical token, or null if untagged
//   caseMatch: bool,             // true if exact case; false → emit N005 warn
//   identifier: string,          // the name part
//   meta: { key: value },        // parsed meta key-values
//   raw: string,                 // original input
//   errors: [{ code, message }]  // parse errors (validator-rules.md codes)
// }
export function parseLayerName(name) {
	const errors = [];
	const result = {
		skip: false,
		classTag: null,
		caseMatch: true,
		identifier: null,
		meta: {},
		raw: name,
		errors
	};

	if (typeof name !== 'string' || name.length === 0) {
		errors.push({ code: 'N003', message: 'empty layer name' });
		return result;
	}

	// Skip rule: leading underscore (no class tag means design-only).
	if (SKIP_RE.test(name) && !name.startsWith('[')) {
		result.skip = true;
		return result;
	}

	// Try tagged form first.
	let m = name.match(TAG_RE);
	if (m) {
		const [, rawTag, ident, metaStr] = m;
		const resolved = resolveToken(rawTag);
		if (!resolved) {
			errors.push({ code: 'N002', message: `unknown class token "${rawTag}"` });
			return result;
		}
		result.classTag = resolved.token;
		result.caseMatch = resolved.caseMatch;
		if (!result.caseMatch) {
			errors.push({ code: 'N005', message: `class token case mismatch: "${rawTag}" should be "${resolved.token}"` });
		}
		if (INVALID_IDENT_CHARS.test(ident)) {
			errors.push({ code: 'N004', message: `identifier "${ident}" contains invalid characters` });
		}
		result.identifier = ident;
		if (metaStr !== undefined) {
			const parsed = parseMeta(metaStr);
			result.meta = parsed.kv;
			errors.push(...parsed.errors);
		}
		return result;
	}

	// Detect malformed tag attempts.
	if (name.startsWith('[')) {
		// "[Sprite cardBack]" or "[Sprite]" without identifier
		if (/^\[\w+\]$/.test(name.trim())) {
			errors.push({ code: 'N003', message: `tag "${name}" missing identifier after [Class]` });
		} else {
			errors.push({ code: 'N003', message: `malformed tag "${name}" — expected [Class] identifier` });
		}
		return result;
	}

	// Untagged form.
	m = name.match(UNTAGGED_RE);
	if (m) {
		const [, ident, metaStr] = m;
		result.identifier = ident;
		if (metaStr !== undefined) {
			const parsed = parseMeta(metaStr);
			result.meta = parsed.kv;
			errors.push(...parsed.errors);
		}
		return result;
	}

	// Identifier with spaces or invalid chars
	if (/^[A-Za-z]/.test(name)) {
		errors.push({ code: 'N004', message: `identifier "${name}" contains invalid characters (spaces, hyphens, etc.)` });
		result.identifier = name.replace(/\s+/g, '_').replace(INVALID_IDENT_CHARS, '_');
		return result;
	}

	errors.push({ code: 'N003', message: `unparseable layer name "${name}"` });
	return result;
}

// Infer class from Figma node when no [Class] tag.
// Returns { token, confidence: 'high'|'medium'|'low', reason } or null.
export function inferClass(node) {
	if (!node || !node.type) return null;
	const type = node.type;
	const fills = node.fills || [];
	const hasImageFill = Array.isArray(fills) && fills.some(f => f && f.type === 'IMAGE');
	const hasSolidFill = Array.isArray(fills) && fills.some(f => f && f.type === 'SOLID');
	const children = node.children || [];
	const hasChildren = children.length > 0;
	const hasComponentSet = node.componentId || node.componentSetId;
	const hasCornerMarkers = children.some(c => /^_corner/.test(c.name || ''));

	if (type === 'TEXT') {
		return { token: 'Text', confidence: 'high', reason: 'TEXT node' };
	}
	if ((type === 'RECTANGLE' || type === 'ELLIPSE') && hasImageFill) {
		return { token: 'Sprite', confidence: 'high', reason: 'RECTANGLE/ELLIPSE with IMAGE fill' };
	}
	if (type === 'INSTANCE' && hasComponentSet) {
		return { token: 'Prefab', confidence: 'high', reason: 'INSTANCE of component (variant via componentProperties)' };
	}
	if (type === 'FRAME' && hasImageFill && hasCornerMarkers) {
		return { token: 'NineSlicePlane', confidence: 'medium', reason: 'FRAME with image + 9-slice corner markers' };
	}
	if (type === 'FRAME' && hasComponentSet) {
		return { token: 'Prefab', confidence: 'high', reason: 'FRAME matches componentId in figma.connect.json' };
	}
	if (type === 'FRAME' && hasChildren && !hasSolidFill && !hasImageFill) {
		return { token: 'Container', confidence: 'high', reason: 'FRAME with children, no fill' };
	}
	if (type === 'GROUP') {
		return { token: 'Container', confidence: 'high', reason: 'GROUP flattens to Container' };
	}
	if ((type === 'RECTANGLE' || type === 'ELLIPSE') && hasSolidFill && !hasChildren) {
		return { token: 'Shape', confidence: 'medium', reason: 'RECTANGLE/ELLIPSE with SOLID fill, no children — prefer explicit [Shape]' };
	}
	if (['BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'REGULAR_POLYGON'].includes(type)) {
		return { token: 'Sprite', confidence: 'low', reason: `unsupported ${type} → emit as Sprite-stub TODO` };
	}
	// Fallback
	return { token: 'Container', confidence: 'low', reason: `unknown node type ${type}, defaulting to Container` };
}

// Validate required meta keys for a given class token.
// Returns array of { code, message } errors.
export function validateMeta(classToken, meta, tokenSpec) {
	const errors = [];
	if (!tokenSpec) return errors;

	for (const required of (tokenSpec.requiredMeta || [])) {
		if (!(required in meta)) {
			const codeMap = {
				NineSlicePlane: 'M001',
				Shape: 'M002',
				ShapeButton: 'M002',
				Resizer: 'M003'
			};
			const code = codeMap[classToken] || 'M001';
			errors.push({ code, message: `${classToken} missing required meta "${required}"` });
		}
	}

	const allowed = new Set([...(tokenSpec.requiredMeta || []), ...(tokenSpec.optionalMeta || [])]);
	for (const key of Object.keys(meta)) {
		if (!allowed.has(key)) {
			errors.push({ code: 'M004', message: `unknown meta key "${key}" for class ${classToken}` });
		}
	}

	return errors;
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const cases = [
		['[Sprite] cardBack', { classTag: 'Sprite', identifier: 'cardBack', skip: false }],
		['[sprite] cardBack', { classTag: 'Sprite', caseMatch: false }],
		['[Shape] divider (shape:rect, color:0x444444)', { classTag: 'Shape', meta: { shape: 'rect', color: 0x444444 } }],
		['[NineSlicePlane] panel (insets:16,16,16,16)', { classTag: 'NineSlicePlane', meta: { insets: [16, 16, 16, 16] } }],
		['[Resizer] hud (normAnchor:0.5,1, useWorld:true)', { classTag: 'Resizer', meta: { normAnchor: [0.5, 1], useWorld: true } }],
		['cardBack', { classTag: null, identifier: 'cardBack' }],
		['_designNote', { skip: true }],
		['[Sprite cardBack]', { errors: [{ code: 'N003' }] }],
		['[Sprite]', { errors: [{ code: 'N003' }] }],
		['[Xyz] foo', { errors: [{ code: 'N002' }] }]
	];
	let fail = 0;
	for (const [input, expected] of cases) {
		const got = parseLayerName(input);
		let ok = true;
		for (const k of Object.keys(expected)) {
			const ev = expected[k];
			if (k === 'meta') {
				ok = ok && JSON.stringify(got.meta) === JSON.stringify(ev);
			} else if (k === 'errors') {
				ok = ok && Array.isArray(got.errors) && got.errors.some(e => e.code === ev[0].code);
			} else {
				ok = ok && got[k] === ev;
			}
		}
		console.log(`${ok ? 'PASS' : 'FAIL'} parseLayerName(${JSON.stringify(input)})`);
		if (!ok) {
			console.log('  got:', JSON.stringify(got));
			fail++;
		}
	}

	const inferCases = [
		[{ type: 'TEXT' }, 'Text'],
		[{ type: 'RECTANGLE', fills: [{ type: 'IMAGE' }] }, 'Sprite'],
		[{ type: 'FRAME', children: [{ name: 'a' }] }, 'Container'],
		[{ type: 'GROUP' }, 'Container'],
		[{ type: 'STAR' }, 'Sprite']
	];
	for (const [node, expectedToken] of inferCases) {
		const got = inferClass(node);
		const ok = got && got.token === expectedToken;
		console.log(`${ok ? 'PASS' : 'FAIL'} inferClass(${node.type}) = ${got?.token}`);
		if (!ok) fail++;
	}
	process.exit(fail);
}
