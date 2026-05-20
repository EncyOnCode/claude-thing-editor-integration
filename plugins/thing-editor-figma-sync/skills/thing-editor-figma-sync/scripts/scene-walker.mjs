#!/usr/bin/env node
// Walk a Thing-Editor .s.json/.p.json. Emit flat map keyed by FULL NAME PATH.
// Usage: node scene-walker.mjs <path-to-scene-or-prefab.json> [--by-name]
// Output: JSON to stdout. Default key = "root/child/grandchild" full chain.
//   --by-name: legacy mode, key by leaf name (collapses duplicates, emits warns).
//
// Each entry: { name, path, namePath, class, prefabRef, props, parentName, parentPath,
//               hasTextDescendant, isText, childIndex, _resize }
//
// _resize: derived flags for patcher refuse-rules. See references/coord-mapping.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEXT_CLASS_RE = /(^|[^A-Za-z])(Text|BitmapText|HTMLText)([^A-Za-z]|$)/;
const LAYOUT_MANAGED_PARENT_CLASSES = new Set(['LayoutGroup', 'LayoutGrid', 'Resizer']);

const args = process.argv.slice(2);
const byName = args.includes('--by-name');
const file = args.find(a => !a.startsWith('--'));
if (!file) {
	console.error('usage: scene-walker.mjs <scene.json> [--by-name]');
	process.exit(1);
}

const root = JSON.parse(readFileSync(resolve(file), 'utf8'));
const out = {};

function isTextClass(cls) {
	if (!cls) return false;
	return TEXT_CLASS_RE.test(cls);
}

function subtreeHasText(node) {
	if (isTextClass(node.c)) return true;
	const children = node[':'] ?? [];
	for (const child of children) {
		if (subtreeHasText(child)) return true;
	}
	return false;
}

function deriveResizeFlags(node, parent) {
	const p = node.p ?? {};
	const pp = parent?.p ?? {};
	const parentClass = parent?.c ?? null;
	const parentIsLayoutManaged = parentClass ? LAYOUT_MANAGED_PARENT_CLASSES.has(parentClass) : false;
	const selfIsLayoutGroup = node.c === 'LayoutGroup' || node.c === 'LayoutGrid' || node.c === 'Resizer';
	return {
		canOverride: !!p.canOverridePivotAndAnchor,
		useWorld: !!p.useWorld,
		stretchAnchorX: Number(p.stretchAnchorX) || 0,
		stretchAnchorY: Number(p.stretchAnchorY) || 0,
		parentClass,
		parentIsLayoutManaged,
		parentSizeModeH: pp.sizeModeH || 'none',
		parentSizeModeV: pp.sizeModeV || 'none',
		selfIsLayoutGroup,
		selfDynamicSize: !!p.dynamicSize,
		selfOrientation: p.orientation || null
	};
}

function walk(node, path, parentNamePath, parentName, childIndex, parent) {
	const props = node.p ?? {};
	const name = props.name ?? null;
	const cls = node.c ?? null;
	const prefabRef = node.r ?? null;
	const isText = isTextClass(cls);
	const hasTextDescendant = subtreeHasText(node);

	const segment = name ?? `<unnamed#${childIndex ?? 0}>`;
	const namePath = parentNamePath ? `${parentNamePath}/${segment}` : segment;

	const entry = {
		name,
		namePath,
		path,
		parentPath: parentNamePath ?? null,
		parentName: parentName ?? null,
		childIndex: childIndex ?? null,
		class: cls,
		prefabRef,
		props,
		isText,
		hasTextDescendant,
		_resize: deriveResizeFlags(node, parent)
	};

	const key = byName ? (name ?? namePath) : namePath;
	if (out[key]) {
		console.error(`warn: duplicate key "${key}" at ${pathStr(path)} (prev at ${pathStr(out[key].path)})`);
	}
	out[key] = entry;

	const children = node[':'] ?? [];
	children.forEach((child, i) => {
		walk(child, [...path, ':', i], namePath, name ?? parentName, i, node);
	});
}

function pathStr(p) {
	return p.length === 0 ? '<root>' : p.join('.');
}

walk(root, [], null, null, null, null);
process.stdout.write(JSON.stringify(out, null, 2));
