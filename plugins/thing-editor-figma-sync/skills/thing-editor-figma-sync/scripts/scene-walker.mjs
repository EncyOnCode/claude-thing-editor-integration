#!/usr/bin/env node
// Walk a Thing-Editor .s.json/.p.json. Emit flat map keyed by FULL NAME PATH.
// Usage: node scene-walker.mjs <path-to-scene-or-prefab.json> [--by-name] [--project <root>]
// Output: JSON to stdout. Default key = "root/child/grandchild" full chain.
//   --by-name: legacy mode, key by leaf name (collapses duplicates, emits warns).
//   --project: path to a Thing-Editor project (containing thing-project.json). Loads the
//              class registry and uses it to classify custom classes (inheritance chain,
//              isText, isLayoutManaged). Without --project, the hardcoded fallback set
//              (LayoutGroup/LayoutGrid/Resizer) is used and custom subclasses are missed.
//              If <project>/.thing-editor-meta/snapshots/<scene>.json exists (produced
//              by the editor's "Export Figma-Sync metadata" command), every flat-map
//              entry is augmented with `world` (true rendered transform), `localEngine`
//              (engine-observed local), and `resizeEngine` (effective resize state
//              after recalculateCoordinates).
//
// Each entry: { name, path, namePath, class, prefabRef, props, parentName, parentPath,
//               hasTextDescendant, isText, childIndex, _resize, chain,
//               world?, localEngine?, resizeEngine?, engineVisible?, fromEngineSnapshot? }
//
// _resize: derived flags for patcher refuse-rules. See references/coord-mapping.md.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadRegistry } from './shared/project-class-registry.mjs';

const TEXT_CLASS_RE = /(^|[^A-Za-z])(Text|BitmapText|HTMLText)([^A-Za-z]|$)/;
const FALLBACK_LAYOUT_PARENTS = new Set(['LayoutGroup', 'LayoutGrid', 'Resizer']);

const args = process.argv.slice(2);
const byName = args.includes('--by-name');
const projectIdx = args.indexOf('--project');
const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--project');
if (!file) {
	console.error('usage: scene-walker.mjs <scene.json> [--by-name] [--project <root>]');
	process.exit(1);
}

let registry = null;
if (projectRoot) {
	try {
		registry = loadRegistry(projectRoot);
	} catch (e) {
		console.error(`warn: failed to load class registry from ${projectRoot}: ${e.message}`);
	}
}

// Optional engine snapshot lookup. Derive scene name from input filename
// (`main.s.json` → `main`). For prefabs the editor exporter today only writes
// scenes; snapshot will simply be absent and we silently skip augmentation.
let engineSnapshotByScenePath = null;
let engineSnapshotPath = null;
if (projectRoot) {
	const sceneName = basename(file).replace(/\.(s|p)\.json$/, '');
	const candidate = join(resolve(projectRoot), '.thing-editor-meta', 'snapshots', sceneName + '.json');
	if (existsSync(candidate)) {
		try {
			const snap = JSON.parse(readFileSync(candidate, 'utf8'));
			engineSnapshotByScenePath = indexSnapshotByScenePath(snap.root);
			engineSnapshotPath = candidate;
		} catch (e) {
			console.error(`warn: failed to parse engine snapshot ${candidate}: ${e.message}`);
		}
	}
}

function indexSnapshotByScenePath(rootNode) {
	const m = new Map();
	const visit = (n) => {
		m.set(JSON.stringify(n.scenePath ?? []), n);
		(n.children ?? []).forEach(visit);
	};
	visit(rootNode);
	return m;
}

if (engineSnapshotPath) {
	console.error(`info: hydrating from engine snapshot ${engineSnapshotPath} (${engineSnapshotByScenePath.size} nodes)`);
}

function classifyClass(cls) {
	if (!cls) return { chain: null, isText: false, isLayoutManaged: false };
	if (registry?.classes?.[cls]) {
		const c = registry.classes[cls];
		return { chain: c.chain, isText: c.isText, isLayoutManaged: c.isLayoutManaged };
	}
	return {
		chain: null,
		isText: TEXT_CLASS_RE.test(cls),
		isLayoutManaged: FALLBACK_LAYOUT_PARENTS.has(cls)
	};
}

const root = JSON.parse(readFileSync(resolve(file), 'utf8'));
const out = {};

function subtreeHasText(node) {
	if (classifyClass(node.c).isText) return true;
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
	const parentIsLayoutManaged = classifyClass(parentClass).isLayoutManaged;
	const selfClassInfo = classifyClass(node.c);
	const selfIsLayoutGroup = selfClassInfo.isLayoutManaged;
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
	const info = classifyClass(cls);
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
		chain: info.chain,
		prefabRef,
		props,
		isText: info.isText,
		hasTextDescendant,
		_resize: deriveResizeFlags(node, parent)
	};

	if (engineSnapshotByScenePath) {
		const snap = engineSnapshotByScenePath.get(JSON.stringify(path));
		if (snap) {
			entry.world = snap.world;
			entry.localEngine = snap.local;
			entry.resizeEngine = snap.resize;
			entry.engineVisible = snap.visible;
			entry.fromEngineSnapshot = true;
		}
	}

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
