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

// Phase B — known dynamic engine classes. Subtree gets isDynamic=true if class
// itself or any class in chain matches.
const DYNAMIC_ENGINE_CLASSES = new Set([
	'Trigger',
	'MovieClip',
	'Spawner',
	'ParticleContainer',
	'Spine',
	'AnimatedSprite'
]);
// Class-name naming-convention regex — classes whose names end with these
// suffixes are heuristically treated as runtime-controlled. Loose, but the
// pre-apply gate provides a backstop, and projects can opt out with
// "autoExcludeDynamic": false in figma.sync.json.
const DYNAMIC_NAME_SUFFIX_RE = /(Controller|Manager|Animator|Spawner|Mover)$/;

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
const byName = args.includes('--by-name');
const projectIdx = args.indexOf('--project');
const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : null;
const extraDynamicClassesStr = flagValue('--dynamic-classes');
const extraDynamicClasses = extraDynamicClassesStr
	? new Set(extraDynamicClassesStr.split(',').map(s => s.trim()).filter(Boolean))
	: null;
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--project' && args[i - 1] !== '--dynamic-classes');
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

function deriveIsDynamic(cls, chain, prefabRef, parentIsLayoutManaged, parentIsDynamic) {
	// Note: parent-layout-managed alone does NOT mark a node dynamic. Layout-
	// managed children can be patched safely via normalizePos*/normAnchor*
	// (the refuse-matrix already rewrites x/y → norm* for these). Excluding
	// them entirely would block legitimate coord fixes (proven on
	// livegames-checkers where `bet` patches landed correctly via normalizePos).
	if (parentIsDynamic) return { isDynamic: true, reason: 'ancestor' };
	if (prefabRef) return { isDynamic: true, reason: `prefabRef:${prefabRef}` };
	if (!cls) return { isDynamic: false, reason: null };
	if (DYNAMIC_ENGINE_CLASSES.has(cls)) return { isDynamic: true, reason: `class:${cls}` };
	if (extraDynamicClasses && extraDynamicClasses.has(cls)) return { isDynamic: true, reason: `project-class:${cls}` };
	if (DYNAMIC_NAME_SUFFIX_RE.test(cls)) return { isDynamic: true, reason: `name-suffix:${cls}` };
	if (Array.isArray(chain)) {
		for (const c of chain) {
			if (DYNAMIC_ENGINE_CLASSES.has(c)) return { isDynamic: true, reason: `chain:${c}` };
			if (extraDynamicClasses && extraDynamicClasses.has(c)) return { isDynamic: true, reason: `project-chain:${c}` };
			if (DYNAMIC_NAME_SUFFIX_RE.test(c)) return { isDynamic: true, reason: `chain-name-suffix:${c}` };
		}
	}
	return { isDynamic: false, reason: null };
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

function walk(node, path, parentNamePath, parentName, childIndex, parent, parentIsDynamic) {
	const props = node.p ?? {};
	const name = props.name ?? null;
	const cls = node.c ?? null;
	const prefabRef = node.r ?? null;
	const info = classifyClass(cls);
	const hasTextDescendant = subtreeHasText(node);

	const segment = name ?? `<unnamed#${childIndex ?? 0}>`;
	const namePath = parentNamePath ? `${parentNamePath}/${segment}` : segment;
	const resize = deriveResizeFlags(node, parent);
	const dyn = deriveIsDynamic(cls, info.chain, prefabRef, resize.parentIsLayoutManaged, !!parentIsDynamic);

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
		isDynamic: dyn.isDynamic,
		dynamicReason: dyn.reason,
		_resize: resize
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
		walk(child, [...path, ':', i], namePath, name ?? parentName, i, node, entry.isDynamic);
	});
}

function pathStr(p) {
	return p.length === 0 ? '<root>' : p.join('.');
}

walk(root, [], null, null, null, null, false);
process.stdout.write(JSON.stringify(out, null, 2));
