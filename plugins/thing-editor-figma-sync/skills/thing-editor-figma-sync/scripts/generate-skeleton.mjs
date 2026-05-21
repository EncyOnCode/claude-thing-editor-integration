#!/usr/bin/env node
// Workflow C: generate a Thing-Editor scene/prefab skeleton from a Figma snapshot.
// Output: .s.json or .p.json + companion .TODO.md sidecar.
//
// Usage:
//   node generate-skeleton.mjs \
//     --figma <snapshot.json> \
//     --out <path/to/out.{s,p}.json> \
//     [--prefab]                      # emit Container root (no Scene wrapper)
//     [--project <path>]              # enables prefab existence + texture-base checks
//     [--connect <figma.connect.json>]
//     [--root-class Main|Scene|Container]
//     [--orientation portrait|landscape]
//     [--dry]                         # print to stdout, no write

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLASS_TOKENS, extendTokens, getTokenSpec, isTextClass } from './shared/class-tokens.mjs';
import { figmaToScene, extractTint, degToRad } from './shared/coord-resolve.mjs';
import { resolveTextureBase } from './shared/texture-base.mjs';
import { readConnectMap, findMapping, resolveVariant } from './shared/connect-map.mjs';
import { loadRegistry } from './shared/project-class-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function flagValue(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
function flagPresent(name) { return args.includes(name); }

const figmaPath = flagValue('--figma');
const outPath = flagValue('--out');
const isPrefab = flagPresent('--prefab');
const projectRoot = flagValue('--project');
const connectPath = flagValue('--connect');
const rootClass = flagValue('--root-class') || (isPrefab ? 'Container' : 'Scene');
const orientation = flagValue('--orientation') || 'landscape';
const dry = flagPresent('--dry');

if (!figmaPath || !outPath) {
	console.error('usage: generate-skeleton.mjs --figma <snapshot.json> --out <path> [--prefab] [--project <path>] [--connect <path>] [--root-class <class>] [--orientation portrait|landscape] [--dry]');
	process.exit(2);
}

// Inject custom class tokens BEFORE walking figma so layer.classTag for things
// like [CardItem] gets resolved instead of falling to N002 + Container fallback.
let registry = null;
if (projectRoot) {
	try {
		registry = loadRegistry(projectRoot);
		extendTokens(registry);
	} catch (e) {
		console.error(`warn: failed to load class registry: ${e.message}`);
	}
}

const figmaSnap = ensureWalkedFigma(figmaPath);
const connectMap = connectPath ? readConnectMap(connectPath) : null;

// Build a parent map from layers
const layerByPath = figmaSnap.layers;
const todos = []; // sidecar entries
let inferenceCount = 0;

// Find root layer
const rootLayer = findRoot(layerByPath);
if (!rootLayer) {
	console.error('error: cannot find root layer in figma snapshot');
	process.exit(2);
}

// Build scene tree recursively
const sceneTree = buildNode(rootLayer, null, true);

// Wrap if needed
let finalOutput;
if (isPrefab) {
	finalOutput = sceneTree;
} else {
	// Wrap with Scene unless already root
	if (sceneTree.c === 'Scene') {
		finalOutput = sceneTree;
	} else {
		finalOutput = {
			c: rootClass,
			p: { name: 'main' },
			[':']: [sceneTree]
		};
	}
}

// Emit
const outAbs = resolve(outPath);
const json = JSON.stringify(finalOutput, null, '\t') + '\n';
if (dry) {
	console.log(json);
} else {
	writeFileSync(outAbs, json);
	const todoPath = outAbs.replace(/\.(s|p)\.json$/, '.TODO.md').replace(/\.json$/, '.TODO.md');
	writeFileSync(todoPath, renderTodoSidecar(todos, outAbs));
	console.error(`wrote ${outAbs}`);
	console.error(`wrote ${todoPath} (${todos.length} TODOs, ${inferenceCount} auto-inferred classes)`);
}

// ---- functions ----

function findRoot(layers) {
	// Root = layer with parentPath === null OR shortest path
	const entries = Object.entries(layers);
	if (entries.length === 0) return null;
	const noParent = entries.filter(([, l]) => !l.parentPath);
	if (noParent.length > 0) return noParent[0][1];
	// Fallback: shortest path
	entries.sort((a, b) => a[0].length - b[0].length);
	return entries[0][1];
}

function buildNode(layer, parentLayer, isRoot) {
	if (layer.skip) return null;
	const classTag = layer.classTag;

	// Special: [ref] — no node emitted
	if (classTag === 'ref') {
		todos.push({
			priority: 'high',
			level: '[ref]',
			message: `${layer.path} → \`[ref] ${layer.identifier}\` — code-side construction expected; no node generated.`
		});
		return null;
	}

	// Special: [Prefab] — emit "r":"name" reference, no children
	if (classTag === 'Prefab') {
		return buildPrefabRef(layer, parentLayer);
	}

	// Auto-inferred classes get logged
	if (layer.inferredClass) {
		inferenceCount++;
		todos.push({
			priority: layer.inferredClass.confidence === 'low' ? 'high' : 'medium',
			level: 'infer',
			message: `${layer.path} → no [Class] tag; inferred ${layer.inferredClass.token} (${layer.inferredClass.confidence}: ${layer.inferredClass.reason}). Consider promoting to explicit tag.`
		});
	}

	// Unknown / no class → emit Container as fallback
	const tokenSpec = getTokenSpec(classTag);
	if (!tokenSpec) {
		todos.push({
			priority: 'high',
			level: 'class',
			message: `${layer.path} → unrecognized class "${classTag}"; emitted as Container.`
		});
		return buildContainerNode(layer, parentLayer);
	}

	// Custom classes from project registry: emit with class name preserved and
	// inheritance chain logged so the author knows what built-in ancestor it
	// derives from. @editable fields (data-paths, callbacks, DI tokens) aren't
	// auto-filled — that needs Phase 2 of the registry parsing @editable blocks.
	const isCustomClass = tokenSpec.custom === true;

	// Build geometry
	const parentBox = parentLayer?.bbox || figmaSnap.root?.bbox || { x: 0, y: 0 };
	const parentOrigin = { x: parentBox.x, y: parentBox.y };

	let textureBase = null;
	if ((classTag === 'Sprite' || classTag === 'DSprite') && projectRoot && layer.identifier) {
		textureBase = resolveTextureBase(layer.identifier, projectRoot);
		if (!textureBase) {
			textureBase = resolveTextureBase(layer.identifier + '.png', projectRoot);
		}
		if (!textureBase) {
			todos.push({
				priority: 'medium',
				level: 'asset',
				message: `${layer.path} → texture base size for "${layer.identifier}" unknown; scale skipped. Place asset in assets/img/ or update prop manually.`
			});
		}
	}

	const isTextNode = isTextClass(classTag);
	const skipScale = isTextNode || subtreeHasText(layer);

	const geom = figmaToScene(
		{ absoluteBoundingBox: layer.bbox, rotation: layer.rotation, opacity: layer.opacity, fills: layer.fills },
		isRoot ? { x: layer.bbox?.x ?? 0, y: layer.bbox?.y ?? 0 } : parentOrigin,
		classTag,
		{ textureBase, skipScale, meta: layer.meta || {} }
	);

	if (isRoot) {
		// Root: position at 0,0 relative to itself
		geom.x = 0;
		geom.y = 0;
	}

	const props = { name: layer.identifier || layer.name };

	// Class-specific emit
	const cls = tokenSpec.engineClass || classTag;
	switch (classTag) {
		case 'Sprite':
		case 'DSprite':
		case 'Button':
		case 'MovieClip':
			emitSprite(layer, props, geom, classTag);
			break;
		case 'Text':
		case 'Label':
		case 'BitmapText':
		case 'HTMLText':
			emitText(layer, props, geom, classTag);
			break;
		case 'NineSlicePlane':
			emitNineSlice(layer, props, geom);
			break;
		case 'Shape':
		case 'ShapeButton':
			emitShape(layer, props, geom);
			break;
		case 'SizedContainer':
		case 'Container':
		case 'ScrollLayer':
		case 'ParticleContainer':
		case 'Mask':
		case 'Trigger':
		case 'ParticleSystem':
		case 'Spawner':
			emitContainer(layer, props, geom);
			break;
		case 'Resizer':
			emitResizer(layer, props, geom);
			break;
		case 'LayoutGroup':
			emitLayoutGroup(layer, props, geom);
			break;
		case 'OrientationTrigger':
			emitOrientationTrigger(layer, props, geom);
			break;
		case 'Scene':
			props.backgroundColor = 0;
			break;
		case 'Spine':
			todos.push({
				priority: 'medium',
				level: 'animation',
				message: `${layer.path} → [Spine] timeline cannot be generated. Author in editor.`
			});
			break;
	}

	if (isCustomClass) {
		const chainStr = tokenSpec.chain ? tokenSpec.chain.join(' -> ') : classTag;
		todos.push({
			priority: 'medium',
			level: 'custom',
			message: `${layer.path} → custom class ${classTag} (chain: ${chainStr}). x/y/scale derived from ancestry; @editable fields (data-paths, callbacks, DI tokens) require manual review.`
		});
	}

	// Common position props
	if (geom.x !== undefined && geom.x !== 0) props.x = round(geom.x);
	if (geom.y !== undefined && geom.y !== 0) props.y = round(geom.y);
	if (geom.scaleX !== undefined) props['scale.x'] = round(geom.scaleX, 4);
	if (geom.scaleY !== undefined) props['scale.y'] = round(geom.scaleY, 4);
	if (geom.rotation !== undefined && geom.rotation !== 0) props.rotation = round(geom.rotation, 4);
	if (geom.alpha !== undefined && geom.alpha !== 1) props.alpha = round(geom.alpha, 3);
	if (geom.tint !== undefined && geom.tint !== 0xffffff) props.tint = geom.tint;

	const node = { c: cls, p: props };

	// Children
	const children = findChildLayers(layer);
	const childNodes = [];
	for (const child of children) {
		const childNode = buildNode(child, layer, false);
		if (childNode) childNodes.push(childNode);
	}
	if (childNodes.length > 0) {
		node[':'] = childNodes;
	}

	// Inline TODO marker (triple underscore — stripped on first editor save)
	const inlineTodos = collectInlineTodos(layer, classTag);
	if (inlineTodos.length > 0) {
		node['___TODO'] = inlineTodos.join(' | ');
	}

	return node;
}

function buildPrefabRef(layer, parentLayer) {
	const parentBox = parentLayer?.bbox || figmaSnap.root?.bbox || { x: 0, y: 0 };
	const variantName = layer.meta?.variant;

	let prefabName = layer.identifier;
	// Lookup connect-map for variant
	if (connectMap) {
		const cm = findMapping(connectMap, { id: layer.id, componentSetId: layer.componentSetId });
		if (cm && variantName) {
			const resolved = resolveVariant(cm, { variant: variantName });
			if (resolved) prefabName = resolved;
		}
	}

	// Verify prefab exists
	if (projectRoot && prefabName) {
		const prefabFile = join(resolve(projectRoot), 'assets', 'prefabs', `${prefabName}.p.json`);
		try {
			readFileSync(prefabFile);
		} catch {
			todos.push({
				priority: 'high',
				level: '[Prefab]',
				message: `${layer.path} → \`[Prefab] ${prefabName}\` — ${prefabFile} not found. Create prefab or change tag to [Container].`
			});
		}
	}

	const node = {
		r: prefabName,
		p: {
			name: layer.identifier,
			x: round(layer.bbox?.x - parentBox.x ?? 0),
			y: round(layer.bbox?.y - parentBox.y ?? 0)
		}
	};

	// INSTANCE overrides: text and tint
	if (layer.characters) node.p.text = layer.characters;
	const tint = extractTint(layer.fills);
	if (tint != null && tint !== 0xffffff) node.p.tint = tint;

	return node;
}

function emitSprite(layer, props, geom, classTag) {
	if (layer.identifier) {
		// Try to guess image asset path
		props.image = guessImagePath(layer.identifier);
	}
	if (geom.__textureBaseUnknown) {
		// Already logged in buildNode; flag inline
		props.___TODO_scale = 'texture base unknown; verify scale manually';
	}
}

function emitText(layer, props, geom, classTag) {
	props.text = layer.characters || '';
	if (layer.style?.fontSize) props['style.fontSize'] = layer.style.fontSize;
	if (layer.style?.fontFamily) props['style.fontFamily'] = layer.style.fontFamily;
	const tint = extractTint(layer.fills);
	if (tint != null) props['style.fill'] = tint;
	if (layer.style?.textAlignHorizontal) {
		const map = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };
		props['style.align'] = map[layer.style.textAlignHorizontal] || layer.style.textAlignHorizontal.toLowerCase();
	}
	// L10n hint
	if (props.text && props.text.length > 0 && props.text.length < 60 && !/[0-9]/.test(props.text)) {
		todos.push({
			priority: 'medium',
			level: 'l10n',
			message: `${layer.path} → \`${props.text}\` — possibly L10n. Convert to translatableText with project L10n key.`
		});
	}
}

function emitNineSlice(layer, props, geom) {
	if (layer.identifier) props.image = guessImagePath(layer.identifier);
	const insets = layer.meta?.insets;
	if (Array.isArray(insets) && insets.length === 4) {
		props.leftWidth = insets[0];
		props.topHeight = insets[1];
		props.rightWidth = insets[2];
		props.bottomHeight = insets[3];
	}
	props.width = layer.bbox?.width || 100;
	props.height = layer.bbox?.height || 100;
}

function emitShape(layer, props, geom) {
	const meta = layer.meta || {};
	if (meta.shape) {
		const shapeMap = { rect: 0, circle: 1, ring: 2, line: 3 };
		props.shape = shapeMap[meta.shape] ?? 0;
	}
	if (meta.color !== undefined) props.shapeFillColor = meta.color;
	if (meta.radius !== undefined) props.shapeRadius = meta.radius;
	if (meta.thickness !== undefined) props.shapeLineWidth = meta.thickness;
	props.width = layer.bbox?.width || 100;
	props.height = layer.bbox?.height || 100;
}

function emitContainer(layer, props, geom) {
	if (layer.classTag === 'SizedContainer') {
		props.width = layer.bbox?.width || 0;
		props.height = layer.bbox?.height || 0;
	}
}

function buildContainerNode(layer, parentLayer) {
	const props = { name: layer.identifier || layer.name };
	const parentBox = parentLayer?.bbox || figmaSnap.root?.bbox || { x: 0, y: 0 };
	const x = (layer.bbox?.x ?? 0) - parentBox.x;
	const y = (layer.bbox?.y ?? 0) - parentBox.y;
	if (x !== 0) props.x = round(x);
	if (y !== 0) props.y = round(y);
	const children = findChildLayers(layer).map(c => buildNode(c, layer, false)).filter(Boolean);
	const node = { c: 'Container', p: props };
	if (children.length > 0) node[':'] = children;
	return node;
}

function emitResizer(layer, props, geom) {
	props.canOverridePivotAndAnchor = true;
	const m = layer.meta || {};
	if (Array.isArray(m.normAnchor)) {
		props.normAnchorX = m.normAnchor[0];
		props.normAnchorY = m.normAnchor[1];
	}
	if (Array.isArray(m.normPivot)) {
		props.normPivotX = m.normPivot[0];
		props.normPivotY = m.normPivot[1];
	}
	if (Array.isArray(m.stretchAnchor)) {
		props.stretchAnchorX = m.stretchAnchor[0];
		props.stretchAnchorY = m.stretchAnchor[1];
	}
	if (m.useWorld) props.useWorld = true;
}

function emitLayoutGroup(layer, props, geom) {
	const m = layer.meta || {};
	if (m.direction === 'row') props.orientation = 'Horizontal';
	else if (m.direction === 'col') props.orientation = 'Vertical';
	if (m.gap !== undefined) {
		props.spacingX = m.gap;
		props.spacingY = m.gap;
	}
	if (m.align === 'start') props.aligmentX = 0;
	else if (m.align === 'center') props.aligmentX = 0.5;
	else if (m.align === 'end') props.aligmentX = 1;
}

function emitOrientationTrigger(layer, props, geom) {
	const mode = layer.meta?.mode;
	props.x = round(geom.x);
	props.y = round(geom.y);
	if (mode === 'portrait') {
		props.portraitX = round(geom.x);
		props.portraitY = round(geom.y);
		todos.push({
			priority: 'low',
			level: 'orientation',
			message: `${layer.path} → portrait variant emitted. If you also have a landscape variant, add a sibling [OrientationTrigger] ... (mode:landscape) frame in Figma.`
		});
	} else if (mode === 'landscape') {
		props.landscapeX = round(geom.x);
		props.landscapeY = round(geom.y);
	}
}

function findChildLayers(parent) {
	const children = [];
	for (const layer of Object.values(layerByPath)) {
		if (layer.parentPath === parent.path) {
			children.push(layer);
		}
	}
	return children;
}

function subtreeHasText(layer) {
	if (isTextClass(layer.classTag)) return true;
	for (const child of findChildLayers(layer)) {
		if (subtreeHasText(child)) return true;
	}
	return false;
}

function collectInlineTodos(layer, classTag) {
	const inline = [];
	if (classTag === 'ParticleSystem' || classTag === 'Spawner') {
		inline.push(`${classTag} config cannot be generated — author in editor`);
	}
	if (classTag === 'MovieClip') {
		inline.push('MovieClip timeline cannot be generated — author in editor');
	}
	if (classTag === 'Trigger' && layer.meta?.cond === undefined) {
		inline.push('Trigger condition (dataPath) not generated — set manually');
	}
	if (classTag === 'Spine') {
		inline.push('Spine skeleton not generated — author in editor');
	}
	return inline;
}

function guessImagePath(identifier) {
	// Strip extension if present
	const base = identifier.replace(/\.(png|jpg|jpeg|webp)$/, '');
	return `img/${base}.png`;
}

function round(n, places = 2) {
	const m = Math.pow(10, places);
	return Math.round(n * m) / m;
}

function ensureWalkedFigma(path) {
	const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
	if (raw.layers) return raw;
	const walkerPath = join(__dirname, 'figma-walker.mjs');
	const walkerArgs = [walkerPath, resolve(path)];
	if (projectRoot) walkerArgs.push('--project', resolve(projectRoot));
	const res = spawnSync('node', walkerArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error(`failed to walk figma snapshot: ${res.stderr}`);
		process.exit(2);
	}
	return JSON.parse(res.stdout);
}

function renderTodoSidecar(todos, outFile) {
	const date = new Date().toISOString().slice(0, 10);
	const grouped = { high: [], medium: [], low: [] };
	for (const t of todos) grouped[t.priority]?.push(t);

	const lines = [];
	lines.push(`# TODO: ${basename(outFile)} (generated ${date})`);
	lines.push('');
	lines.push('Review this file BEFORE opening the generated .json in editor — inline `___TODO` markers are stripped on first save.');
	lines.push('');
	if (grouped.high.length) {
		lines.push('## High priority — must address');
		for (const t of grouped.high) lines.push(`- [ ] ${t.message}`);
		lines.push('');
	}
	if (grouped.medium.length) {
		lines.push('## Medium priority — likely wrong, verify');
		for (const t of grouped.medium) lines.push(`- [ ] ${t.message}`);
		lines.push('');
	}
	if (grouped.low.length) {
		lines.push('## Low priority — informational');
		for (const t of grouped.low) lines.push(`- [ ] ${t.message}`);
		lines.push('');
	}
	lines.push('## Engine fields not auto-emitted');
	lines.push('');
	lines.push('For each generated class, reference the matching `@editable` field list in:');
	lines.push('`thing-editor-deep/references/03-components.md`');
	lines.push('');
	lines.push('Common manual additions (cannot be inferred from Figma):');
	lines.push('- `data-path` properties (`"this.#child"`, `"all.cardFactory"`)');
	lines.push('- callbacks (onClick, onChange, MovieClip onComplete)');
	lines.push('- DI tokens (@inject decorators)');
	lines.push('- `translatableText` keys (L10n table)');
	lines.push('- editor-only flags (`__deepness`, `__lockSelection`)');
	return lines.join('\n');
}
