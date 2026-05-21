#!/usr/bin/env node
// Walk a pre-fetched Figma snapshot (from fetch-figma.mjs OR raw Framelink output).
// Classify each layer via [Class] name tag (or auto-infer). Emit flat map.
//
// Input shapes supported:
//   A. Output of fetch-figma.mjs: { fileKey, nodeId, root, nodes: { "parent/name": {...} } }
//   B. Raw Figma REST response: data.nodes[nodeId].document (recursive tree)
//   C. Framelink output: { metadata, nodes: [...] } (tree)
//
// Output: { fileKey?, nodeId?, root?, layers: { figmaPath: { id, name, type, classTag, identifier, meta, bbox, ..., classifyErrors: [...] } } }
//
// Usage:
//   node figma-walker.mjs <snapshot.json> [--json <out.json>] [--project <root>]
//
// --project loads the class registry and registers custom class tokens so layer
// names like [CardItem] or [AnimatedLayoutGroup] resolve instead of emitting
// N002 "unknown class token". Required only when projects use custom classes;
// for engine/lib-only tags it is optional.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLayerName, inferClass } from './shared/figma-classify.mjs';
import { CLASS_TOKENS, extendTokens } from './shared/class-tokens.mjs';
import { loadRegistry } from './shared/project-class-registry.mjs';

const args = process.argv.slice(2);
const flagJsonIdx = args.indexOf('--json');
const jsonOut = flagJsonIdx >= 0 ? args[flagJsonIdx + 1] : null;
const projectIdx = args.indexOf('--project');
const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : null;
const inputFile = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json' && args[i - 1] !== '--project');

if (!inputFile) {
	console.error('usage: figma-walker.mjs <snapshot.json> [--json <out.json>] [--project <root>]');
	process.exit(1);
}

if (projectRoot) {
	try {
		extendTokens(loadRegistry(projectRoot));
	} catch (e) {
		console.error(`warn: failed to load class registry from ${projectRoot}: ${e.message}`);
	}
}

const raw = JSON.parse(readFileSync(resolve(inputFile), 'utf8'));

// Detect input shape and normalize to a tree walker.
let fileKey = raw.fileKey || null;
let nodeId = raw.nodeId || null;
let rootInfo = raw.root || null;
let treeRoot = null;

if (raw.nodes && raw.root) {
	// Shape A: fetch-figma.mjs output. Already flat. We'll re-walk by reconstructing parents.
	// Since the flat shape lacks parent pointers, build a synthetic tree from paths.
	const layers = walkFromFetchFigmaShape(raw);
	emitResult({ fileKey, nodeId, root: rootInfo, layers });
} else if (raw.nodes && Array.isArray(raw.nodes)) {
	// Shape C: Framelink output.
	treeRoot = { name: 'root', type: 'CANVAS', children: raw.nodes };
	const layers = {};
	walkTree(treeRoot, '', null, layers);
	emitResult({ fileKey, nodeId, root: rootInfo, layers });
} else if (raw.document) {
	// Shape B: raw REST response wrapped.
	treeRoot = raw.document;
	const layers = {};
	walkTree(treeRoot, '', null, layers);
	emitResult({ fileKey, nodeId, root: rootInfo, layers });
} else if (raw.id && (raw.children || raw.type)) {
	// Direct node tree.
	treeRoot = raw;
	const layers = {};
	walkTree(treeRoot, '', null, layers);
	emitResult({ fileKey, nodeId, root: rootInfo, layers });
} else {
	console.error('error: unrecognized snapshot shape; expected fetch-figma output or Figma node tree');
	process.exit(1);
}

function walkTree(node, parentPath, parentBox, layers) {
	const name = node.name || '';
	let path = parentPath ? `${parentPath}/${name}` : name;
	// Dedupe: if path collides, suffix with id to keep both entries
	if (layers[path]) {
		path = `${path}#${node.id || Object.keys(layers).length}`;
	}
	const classify = classifyNode(node);
	const bbox = node.absoluteBoundingBox || null;

	layers[path] = {
		id: node.id || null,
		name,
		path,
		type: node.type || null,
		classTag: classify.classTag,
		identifier: classify.identifier,
		meta: classify.meta,
		caseMatch: classify.caseMatch,
		inferredClass: classify.inferred,
		classifyErrors: classify.errors,
		skip: classify.skip,
		bbox,
		rotation: node.rotation ?? 0,
		opacity: node.opacity ?? 1,
		fills: node.fills || null,
		strokes: node.strokes || null,
		effects: node.effects || null,
		characters: node.characters ?? null,
		style: node.style ? {
			fontSize: node.style.fontSize ?? null,
			fontFamily: node.style.fontFamily ?? null,
			textAlignHorizontal: node.style.textAlignHorizontal ?? null,
			textAlignVertical: node.style.textAlignVertical ?? null
		} : null,
		componentId: node.componentId ?? null,
		componentSetId: node.componentSetId ?? null,
		componentProperties: node.componentProperties ?? null,
		parentPath: parentPath || null
	};

	if (classify.skip) return;

	for (const child of (node.children || [])) {
		walkTree(child, path, bbox, layers);
	}
}

function walkFromFetchFigmaShape(raw) {
	const layers = {};
	const entries = Object.entries(raw.nodes);
	for (const [path, n] of entries) {
		const fakeNode = {
			id: n.id,
			name: n.name,
			type: n.type,
			absoluteBoundingBox: n.bbox,
			rotation: n.rotation,
			opacity: n.opacity,
			fills: deSimplifyFills(n.fills),
			characters: n.characters,
			style: {
				fontSize: n.fontSize,
				fontFamily: n.fontFamily,
				textAlignHorizontal: n.textAlignHorizontal
			}
		};
		const classify = classifyNode(fakeNode);
		const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : null;
		layers[path] = {
			id: n.id,
			name: n.name,
			path,
			type: n.type,
			classTag: classify.classTag,
			identifier: classify.identifier,
			meta: classify.meta,
			caseMatch: classify.caseMatch,
			inferredClass: classify.inferred,
			classifyErrors: classify.errors,
			skip: classify.skip,
			bbox: n.bbox,
			rotation: n.rotation,
			opacity: n.opacity,
			fills: deSimplifyFills(n.fills),
			characters: n.characters,
			style: fakeNode.style,
			parentPath
		};
	}
	return layers;
}

function deSimplifyFills(fills) {
	if (!fills) return null;
	// fetch-figma stores simplified tint as int; re-expand to {color: {r,g,b}}
	return fills.map(f => {
		if (f.type === 'SOLID' && typeof f.tint === 'number') {
			const r = ((f.tint >> 16) & 0xff) / 255;
			const g = ((f.tint >> 8) & 0xff) / 255;
			const b = (f.tint & 0xff) / 255;
			return { type: 'SOLID', color: { r, g, b, a: f.alpha }, opacity: f.opacity, visible: f.visible };
		}
		return f;
	});
}

// Classify a node: parse name → derive classTag + identifier + meta. Fall back to inferClass.
function classifyNode(node) {
	const name = node.name || '';
	const parsed = parseLayerName(name);

	const result = {
		classTag: parsed.classTag,
		identifier: parsed.identifier,
		meta: parsed.meta,
		caseMatch: parsed.caseMatch,
		errors: parsed.errors,
		skip: parsed.skip,
		inferred: null
	};

	if (parsed.skip) return result;

	if (!parsed.classTag) {
		// Auto-infer.
		const inf = inferClass(node);
		if (inf) {
			result.classTag = inf.token;
			result.inferred = inf;
		}
	}

	return result;
}

function emitResult(snapshot) {
	const out = JSON.stringify(snapshot, null, 2);
	if (jsonOut) {
		writeFileSync(resolve(jsonOut), out);
		console.error(`wrote ${Object.keys(snapshot.layers).length} layers to ${jsonOut}`);
	} else {
		process.stdout.write(out);
	}
}
