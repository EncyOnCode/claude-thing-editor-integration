#!/usr/bin/env node
// Author figma.connect.json skeletons from a walked Figma snapshot and a
// scene-walker flat map.
//
// Pairs Figma layers with scene entries via the stacked match-strategy
// (namePath → pathSuffix → fuzzyLeaf → bbox). Auto-mapped entries get a
// `scenePath` filled in; unmatched layers get a TODO stub the user can fix
// by hand. The output follows the v2 schema from shared/connect-map.mjs.
//
// Usage:
//   node scaffold-connect.mjs --figma <walked-figma.json> --scene-flat <walker.json>
//     [--out figma.connect.json]
//     [--unmatched-only]
//     [--design-scale N]            # override auto-calibration
//     [--game-width W --game-height H]
//
// Output: JSON connect-map skeleton written to --out (or stdout if omitted).
// Stderr: summary with matched count by confidence + unmatched count.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findSceneMatches } from './shared/match-strategy.mjs';

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const figmaPath = flagValue('--figma');
const sceneFlatPath = flagValue('--scene-flat');
const outPath = flagValue('--out');
const unmatchedOnly = flagPresent('--unmatched-only');
const designScaleOpt = Number(flagValue('--design-scale')) || null;
const gameWidth = Number(flagValue('--game-width')) || null;
const gameHeight = Number(flagValue('--game-height')) || null;

if (!figmaPath || !sceneFlatPath) {
	console.error('usage: scaffold-connect.mjs --figma <walked-figma.json> --scene-flat <scene-walker-output.json> [--out figma.connect.json] [--unmatched-only]');
	process.exit(2);
}
for (const p of [figmaPath, sceneFlatPath]) {
	if (!existsSync(resolve(p))) {
		console.error(`error: file not found: ${p}`);
		process.exit(2);
	}
}

const figmaSnap = JSON.parse(readFileSync(resolve(figmaPath), 'utf8'));
const sceneFlat = JSON.parse(readFileSync(resolve(sceneFlatPath), 'utf8'));

// Derive designScale + figmaRootFrame for bbox strategy.
const figmaRootFrame = findFigmaRootFrame(figmaSnap);
let designScale = designScaleOpt;
let engineMeta = null;
if (gameWidth && gameHeight) {
	engineMeta = { gameSize: { W: gameWidth, H: gameHeight } };
	if (!designScale && figmaRootFrame?.bbox?.width) {
		designScale = gameWidth / figmaRootFrame.bbox.width;
	}
}
// If no game-width supplied, infer from the topmost scene entry's world.bounds
// (typically Main with width = gameSize.W). This makes bbox strategy "just
// work" without forcing the user to remember dimensions.
if (!engineMeta) {
	const top = Object.values(sceneFlat).find(e => !e.parentPath && e.world?.bounds?.width);
	if (top && figmaRootFrame?.bbox?.width) {
		engineMeta = { gameSize: { W: top.world.bounds.width, H: top.world.bounds.height } };
		designScale = designScale || (top.world.bounds.width / figmaRootFrame.bbox.width);
	}
}
designScale = designScale || 1;

const mappings = [];
const confidenceCount = { high: 0, medium: 0, low: 0, bbox: 0, connectMap: 0 };
let matchedCount = 0;
let unmatchedCount = 0;
const claimedKeys = new Set();
const proposals = [];

for (const layer of Object.values(figmaSnap.layers)) {
	if (layer.skip) continue;
	if (!layer.identifier) {
		// design-only or untagged — still surface as TODO so the user sees it.
		proposals.push({ layer, candidates: [] });
		continue;
	}
	const candidates = findSceneMatches(sceneFlat, layer, figmaSnap, {
		designScale,
		engineMeta,
		figmaRootFrame
	});
	proposals.push({ layer, candidates });
}

// Two-pass claim (same as diff-snapshot): high/medium first, then fuzzy/bbox.
const assigned = new Map();
function tryClaim(p) {
	for (const c of p.candidates) {
		if (claimedKeys.has(c.key)) continue;
		claimedKeys.add(c.key);
		assigned.set(p.layer.id, c);
		return c;
	}
	return null;
}
for (const p of proposals) {
	const top = p.candidates[0];
	if (top && (top.confidence === 'high' || top.confidence === 'medium' || top.confidence === 'connectMap')) {
		tryClaim(p);
	}
}
for (const p of proposals) {
	if (assigned.has(p.layer.id)) continue;
	tryClaim(p);
}

for (const p of proposals) {
	const chosen = assigned.get(p.layer.id);
	if (chosen) {
		matchedCount++;
		confidenceCount[chosen.confidence] = (confidenceCount[chosen.confidence] || 0) + 1;
		if (unmatchedOnly) continue;
		mappings.push({
			figmaNodeId: p.layer.id,
			scenePath: chosen.entry.path,
			notes: `auto-matched: figma "${p.layer.name}" → scene "${chosen.namePath}" via ${chosen.matchedBy} (${chosen.confidence})`
		});
	} else {
		unmatchedCount++;
		mappings.push({
			figmaNodeId: p.layer.id,
			scenePath: null,
			notes: `TODO: assign sceneNode for figma "${p.layer.name}" (${p.layer.type}, path: ${p.layer.path ?? 'n/a'})`
		});
	}
}

const out = {
	version: 2,
	figmaFileKey: figmaSnap.fileKey,
	mappings
};

if (outPath) {
	writeFileSync(resolve(outPath), JSON.stringify(out, null, '\t') + '\n');
	console.error(`wrote skeleton to ${outPath}`);
} else {
	process.stdout.write(JSON.stringify(out, null, '\t') + '\n');
}

console.error(
	`${matchedCount} matched (` +
	`high=${confidenceCount.high}, medium=${confidenceCount.medium}, low=${confidenceCount.low}, bbox=${confidenceCount.bbox}` +
	`), ${unmatchedCount} unmatched`
);

process.exit(0);

// --- helpers ---

function findFigmaRootFrame(snap) {
	if (snap?.root?.bbox) return snap.root;
	const layers = snap?.layers ?? {};
	for (const layer of Object.values(layers)) {
		if (!layer.parentPath && layer.bbox) return layer;
	}
	let best = null;
	for (const layer of Object.values(layers)) {
		if (!layer.bbox) continue;
		if (!best || (layer.path?.length ?? 0) < (best.path?.length ?? Infinity)) best = layer;
	}
	return best;
}
