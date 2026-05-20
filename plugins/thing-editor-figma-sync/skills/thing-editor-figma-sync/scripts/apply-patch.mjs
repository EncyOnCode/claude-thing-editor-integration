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

const TEXT_CLASS_RE = /(^|[^A-Za-z])(Text|BitmapText|HTMLText)([^A-Za-z]|$)/;
const SCALE_PROPS = new Set(['scale.x', 'scale.y', 'scale']);
const POSITION_PROPS = new Set(['x', 'y']);
const PIVOT_PROPS = new Set(['pivot.x', 'pivot.y']);
const SIZE_PROPS = new Set(['width', 'height']);
const LAYOUT_MANAGED_PARENT_CLASSES = new Set(['LayoutGroup', 'LayoutGrid', 'Resizer']);
const OVERRIDING_SIZE_MODES = new Set(['both', 'stretch', 'shrink']);

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const [scenePath, patchPath] = positional;
const dry = flags.has('--dry');
const force = flags.has('--force');

if (!scenePath || !patchPath) {
	console.error('usage: apply-patch.mjs <scene.json> <patch.json> [--dry] [--force]');
	process.exit(1);
}

const sceneAbs = resolve(scenePath);
const raw = readFileSync(sceneAbs, 'utf8');
const indent = raw.includes('\n\t') ? '\t' : '  ';
const scene = JSON.parse(raw);
const patches = JSON.parse(readFileSync(resolve(patchPath), 'utf8'));

let applied = 0;
let skipped = 0;
let refused = 0;
const log = [];

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

	if (!node.p) node.p = {};
	const before = node.p[entry.prop];
	node.p[entry.prop] = entry.to;
	log.push(`SET ${fmtPath(entry.scenePath)} ${entry.prop} ${JSON.stringify(before)} -> ${JSON.stringify(entry.to)}`);
	applied++;
}

const serialized = JSON.stringify(scene, null, indent) + '\n';

if (dry) {
	console.log(log.join('\n'));
	console.log(`\nDRY: ${applied} would apply, ${refused} refused, ${skipped} skipped`);
} else {
	if (refused > 0 && !force) {
		console.log(log.join('\n'));
		console.log(`\nABORT: ${refused} entries refused. Re-run with --force to override, or change patch.`);
		process.exit(2);
	}
	writeFileSync(sceneAbs, serialized);
	console.log(log.join('\n'));
	console.log(`\nWROTE ${sceneAbs}: ${applied} applied, ${refused} refused, ${skipped} skipped`);
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
	if (parentClass && LAYOUT_MANAGED_PARENT_CLASSES.has(parentClass)) {
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
