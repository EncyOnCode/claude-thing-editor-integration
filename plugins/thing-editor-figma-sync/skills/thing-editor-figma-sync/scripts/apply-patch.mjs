#!/usr/bin/env node
// Minimal-edit patcher for Thing-Editor scene/prefab JSON.
// Preserves key order, indent style (tabs detected). Only touches keys in patch.
// Refuses scale.x/scale.y patches on Text-class nodes OR any node containing a Text descendant.
//
// Usage: node apply-patch.mjs <scene.json> <patch.json> [--dry] [--force]
//
// patch.json schema (v2 — adds optional "op"):
// [
//   { "scenePath": [":", 0, ":", 2], "prop": "x", "to": 120 },
//   { "scenePath": [...], "prop": "scale.x", "to": 1.05 },
//   { "scenePath": [...], "op": "delete", "prop": "alpha" }
// ]
//
// op: "set" (default) or "delete". v1 patches (no op) treat as set.
//
// scenePath = array from scene-walker output (path field). Points at the NODE (with c/p/:), not into p.
// "prop" supports dot notation (e.g. "scale.x", "pivot.x", "style.fontSize"); matches existing JSON key form.
//
// --force overrides text-scale guard.
// --allow-class-change permits patches to "c" or "r" (refused by default).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEXT_CLASS_RE = /(^|[^A-Za-z])(Text|BitmapText|HTMLText)([^A-Za-z]|$)/;
const SCALE_PROPS = new Set(['scale.x', 'scale.y', 'scale']);

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const [scenePath, patchPath] = positional;
const dry = flags.has('--dry');
const force = flags.has('--force');
const allowClassChange = flags.has('--allow-class-change');

if (!scenePath || !patchPath) {
	console.error('usage: apply-patch.mjs <scene.json> <patch.json> [--dry] [--force] [--allow-class-change]');
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
	const node = locate(scene, entry.scenePath);
	if (!node) {
		log.push(`SKIP missing-node ${fmtPath(entry.scenePath)} ${entry.prop}`);
		skipped++;
		continue;
	}

	const op = entry.op || 'set';

	// Class change guard
	if ((entry.prop === 'c' || entry.prop === 'r') && !allowClassChange) {
		log.push(`REFUSE class-change ${fmtPath(entry.scenePath)} ${entry.prop} -> ${JSON.stringify(entry.to)}  (use --allow-class-change to override)`);
		refused++;
		continue;
	}

	if (SCALE_PROPS.has(entry.prop) && op === 'set' && !force) {
		const guard = textGuard(node);
		if (guard.blocked) {
			log.push(`REFUSE scale-on-text ${fmtPath(entry.scenePath)} ${entry.prop} -> ${JSON.stringify(entry.to)}  (reason: ${guard.reason})`);
			log.push(`       Hint: keep parent scale=1; instead patch each Text leaf's style.fontSize and adjust child x/y to compensate.`);
			refused++;
			continue;
		}
	}

	if (entry.prop === 'c' || entry.prop === 'r') {
		// Class change goes to top of node, not into p
		const before = node[entry.prop];
		if (op === 'delete') {
			delete node[entry.prop];
		} else {
			node[entry.prop] = entry.to;
		}
		log.push(`${op.toUpperCase()} ${fmtPath(entry.scenePath)} ${entry.prop} ${JSON.stringify(before)} -> ${JSON.stringify(node[entry.prop])}`);
		applied++;
		continue;
	}

	if (!node.p) node.p = {};
	const before = node.p[entry.prop];
	if (op === 'delete') {
		delete node.p[entry.prop];
		log.push(`DELETE ${fmtPath(entry.scenePath)} ${entry.prop} ${JSON.stringify(before)} -> <deleted>`);
	} else {
		node.p[entry.prop] = entry.to;
		log.push(`SET ${fmtPath(entry.scenePath)} ${entry.prop} ${JSON.stringify(before)} -> ${JSON.stringify(entry.to)}`);
	}
	applied++;
}

const serialized = JSON.stringify(scene, null, indent) + '\n';

if (dry) {
	console.log(log.join('\n'));
	console.log(`\nDRY: ${applied} would apply, ${refused} refused, ${skipped} skipped`);
} else {
	if (refused > 0 && !force) {
		console.log(log.join('\n'));
		console.log(`\nABORT: ${refused} entries refused (scale on Text-bearing subtree). Re-run with --force to override.`);
		process.exit(2);
	}
	writeFileSync(sceneAbs, serialized);
	console.log(log.join('\n'));
	console.log(`\nWROTE ${sceneAbs}: ${applied} applied, ${refused} refused, ${skipped} skipped`);
}

function locate(root, path) {
	let cur = root;
	for (const seg of path) {
		if (cur == null) return null;
		cur = cur[seg];
	}
	return cur;
}

function fmtPath(p) {
	return p.length === 0 ? '<root>' : p.join('.');
}

function isTextClass(cls) {
	if (!cls) return false;
	return TEXT_CLASS_RE.test(cls);
}

// Returns { blocked: bool, reason: string }.
// Blocks scale patch when self OR any descendant is Text-class.
function textGuard(node) {
	if (isTextClass(node.c)) {
		return { blocked: true, reason: `node class "${node.c}" is Text` };
	}
	const found = findTextDescendant(node);
	if (found) {
		return { blocked: true, reason: `descendant "${found.path}" is class "${found.cls}"` };
	}
	return { blocked: false, reason: '' };
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
