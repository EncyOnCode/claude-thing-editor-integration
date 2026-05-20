#!/usr/bin/env node
// Workflow A: compare a pre-walked Figma snapshot against a Thing-Editor scene/prefab.
// Emits markdown report + optional JSON sidecar + optional patch JSON.
// Default mode is interactive (report only); --auto-apply chains into apply-patch.mjs.
//
// Usage:
//   node diff-snapshot.mjs --figma <figma-snapshot.json> --scene <scene.json>
//     [--connect <figma.connect.json>]
//     [--threshold-px N] [--threshold-scale N] [--threshold-rot N]
//     [--strict]
//     [--report-json <path>]
//     [--patch-out <path>]
//     [--auto-apply]
//     [--screenshot <path.png>]   # Workflow D — deferred, prints message
//
// Exit codes: 0 success, 1 if any 'refuse' severity diffs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mdDiffReport, jsonReport } from './shared/report-format.mjs';
import { readConnectMap, findMapping } from './shared/connect-map.mjs';
import { isTextClass } from './shared/class-tokens.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const figmaPath = flagValue('--figma');
const scenePath = flagValue('--scene');
const connectPath = flagValue('--connect');
const reportJsonPath = flagValue('--report-json');
const patchOutPath = flagValue('--patch-out');
const screenshotPath = flagValue('--screenshot');
const autoApply = flagPresent('--auto-apply');
const strict = flagPresent('--strict');
const thrPx = strict ? 0 : (Number(flagValue('--threshold-px')) || 1);
const thrScale = strict ? 0 : (Number(flagValue('--threshold-scale')) || 0.01);
const thrRotDeg = strict ? 0 : (Number(flagValue('--threshold-rot')) || 1);
const thrRotRad = (thrRotDeg * Math.PI) / 180;

if (!figmaPath || !scenePath) {
	console.error('usage: diff-snapshot.mjs --figma <snapshot.json> --scene <scene.json> [options]');
	process.exit(2);
}

// Workflow D acknowledgement
if (screenshotPath) {
	if (!existsSync(resolve(screenshotPath))) {
		console.error(`error: --screenshot file not found: ${screenshotPath}`);
		process.exit(2);
	}
	console.error(`Visual diff is a future-work feature. Screenshot hook acknowledged. Skipping pixel comparison.`);
}

// Load inputs
const figmaSnap = ensureWalkedFigma(figmaPath);
const sceneFlat = loadSceneFlat(scenePath);
const connectMap = connectPath ? readConnectMap(connectPath) : null;

// Build matches
const matches = [];
const unmatchedFigma = [];
const unmatchedScene = new Set(Object.keys(sceneFlat));
const flags = [];

for (const layer of Object.values(figmaSnap.layers)) {
	if (layer.skip) continue;
	if (!layer.identifier) {
		unmatchedFigma.push({ figmaId: layer.id, name: layer.name, type: layer.type });
		continue;
	}

	// Try matching by namePath (scene flat keyed by namePath)
	const candidates = findSceneMatches(sceneFlat, layer);
	if (candidates.length === 0) {
		// Try connect-map by componentId/componentSetId
		const cm = connectMap && findMapping(connectMap, { id: layer.id, componentSetId: layer.componentSetId });
		if (cm && cm.scenePath) {
			matches.push({ figma: layer, scene: findByPath(sceneFlat, cm.scenePath), matchedBy: 'connectMap' });
			unmatchedScene.delete(findEntryKey(sceneFlat, cm.scenePath));
			continue;
		}
		unmatchedFigma.push({ figmaId: layer.id, name: layer.name, type: layer.type });
		continue;
	}

	const best = candidates[0];
	matches.push({ figma: layer, scene: best.entry, matchedBy: best.matchedBy, namePath: best.namePath });
	unmatchedScene.delete(best.key);
}

// Compute diffs
const diffs = [];
const derivations = [];

for (const { figma, scene } of matches) {
	if (!scene) continue;
	const sceneNode = scene; // entry from scene-walker (has props, path, class, etc.)
	const sceneProps = sceneNode.props || {};
	const figmaBbox = figma.bbox || figma.absoluteBoundingBox;
	if (!figmaBbox) continue;

	// Pre-diff probe: emit flag if special handling needed
	if (sceneNode.canOverridePivotAndAnchor) {
		flags.push({
			scenePath: sceneNode.path,
			code: 'RESIZE_ATTRIB_OVERRIDE',
			level: 'warn',
			message: 'canOverridePivotAndAnchor=true → patches target normPivot*/normAnchor*, not x/y/pivot'
		});
	}
	if (sceneNode.resizeAttribFlags?.useWorld) {
		flags.push({
			scenePath: sceneNode.path,
			code: 'RESIZE_USE_WORLD',
			level: 'info',
			message: 'useWorld=true → dimensions from game.W/H, not parent'
		});
	}
	if (sceneNode.prefabRef) {
		flags.push({
			scenePath: sceneNode.path,
			code: 'PREFAB_REF',
			level: 'info',
			message: `prefab reference "${sceneNode.prefabRef}" — diff covers only instance overrides, not prefab internals`
		});
	}

	// Coordinate diff (x, y, scale, rotation, alpha, tint, text)
	const sceneX = sceneProps.x ?? 0;
	const sceneY = sceneProps.y ?? 0;
	const figmaX = figmaBbox.x; // absolute Figma coord
	const figmaY = figmaBbox.y;

	// Approximate: scene origin in Figma coord space requires knowing root + parent offsets.
	// For per-node diff we compare deltas in matched coordinate frame.
	// User expects diff to show "Figma says X, scene has Y". The translator role belongs to apply-patch derivation; here we report raw.
	// To be useful: compute scene-local Figma position by subtracting parent figma origin (if matched).
	const figmaLocal = computeFigmaLocal(figma, figmaSnap);
	const figmaLocalX = figmaLocal.x;
	const figmaLocalY = figmaLocal.y;

	// x diff
	if (Math.abs(sceneX - figmaLocalX) > thrPx) {
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'x',
			from: sceneX,
			to: round(figmaLocalX),
			delta: round(figmaLocalX - sceneX),
			severity: 'patch',
			reason: `Figma local x = ${round(figmaLocalX)}, scene = ${sceneX}`
		});
	}
	// y diff
	if (Math.abs(sceneY - figmaLocalY) > thrPx) {
		const isCenterCenterText = isTextClass(sceneNode.class) && figma.style?.textAlignVertical === 'CENTER';
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'y',
			from: sceneY,
			to: round(figmaLocalY),
			delta: round(figmaLocalY - sceneY),
			severity: isCenterCenterText ? 'skip' : 'patch',
			reason: isCenterCenterText
				? 'Text center/center Y derivation unreliable from Figma — verify visually'
				: `Figma local y = ${round(figmaLocalY)}, scene = ${sceneY}`
		});
	}

	// rotation
	const figmaRot = (figma.rotation || 0) * Math.PI / 180;
	const sceneRot = sceneProps.rotation ?? 0;
	if (Math.abs(figmaRot - sceneRot) > thrRotRad) {
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'rotation',
			from: sceneRot,
			to: round(figmaRot, 4),
			delta: round(figmaRot - sceneRot, 4),
			severity: 'patch',
			reason: `Figma rotation ${figma.rotation}° = ${round(figmaRot, 4)}rad`
		});
	}

	// alpha
	const figmaAlpha = figma.opacity ?? 1;
	const sceneAlpha = sceneProps.alpha ?? 1;
	if (Math.abs(figmaAlpha - sceneAlpha) > 0.01) {
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'alpha',
			from: sceneAlpha,
			to: round(figmaAlpha, 3),
			delta: round(figmaAlpha - sceneAlpha, 3),
			severity: 'patch',
			reason: `Figma opacity ${figmaAlpha}, scene alpha ${sceneAlpha}`
		});
	}

	// tint from first SOLID fill
	const figmaTint = extractTintFromFills(figma.fills);
	const sceneTint = sceneProps.tint ?? 0xffffff;
	if (figmaTint != null && figmaTint !== sceneTint) {
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'tint',
			from: sceneTint,
			to: figmaTint,
			delta: null,
			severity: 'patch',
			reason: `Figma fill 0x${figmaTint.toString(16).padStart(6, '0')}, scene tint 0x${sceneTint.toString(16).padStart(6, '0')}`
		});
	}

	// Text content
	if (isTextClass(sceneNode.class) && figma.characters != null && figma.characters !== sceneProps.text) {
		diffs.push({
			scenePath: sceneNode.path,
			prop: 'text',
			from: sceneProps.text,
			to: figma.characters,
			delta: null,
			severity: 'patch',
			reason: 'Figma characters differ from scene text'
		});
	}

	// fontSize for Text
	if (isTextClass(sceneNode.class) && figma.style?.fontSize != null) {
		const sceneFontSize = sceneProps['style.fontSize'];
		if (sceneFontSize != null && figma.style.fontSize !== sceneFontSize) {
			diffs.push({
				scenePath: sceneNode.path,
				prop: 'style.fontSize',
				from: sceneFontSize,
				to: figma.style.fontSize,
				delta: figma.style.fontSize - sceneFontSize,
				severity: 'patch',
				reason: `Figma fontSize ${figma.style.fontSize}, scene ${sceneFontSize}`
			});
		}
	}
}

// Build summary
const summary = {
	matched: matches.length,
	diffs: diffs.length,
	patches: diffs.filter(d => d.severity === 'patch').length,
	skipped: diffs.filter(d => d.severity === 'skip').length,
	refused: diffs.filter(d => d.severity === 'refuse').length,
	figmaOnly: unmatchedFigma.length,
	sceneOnly: unmatchedScene.size,
	flags: flags.length
};

const reportObj = {
	scene: scenePath,
	figma: { fileKey: figmaSnap.fileKey, nodeId: figmaSnap.nodeId },
	matches: matches.map(m => ({
		scenePath: m.scene?.path,
		figmaId: m.figma.id,
		matchedBy: m.matchedBy,
		namePath: m.namePath
	})),
	diffs,
	derivations,
	flags,
	unmatched: {
		figmaOnly: unmatchedFigma,
		sceneOnly: Array.from(unmatchedScene).map(k => ({ scenePath: sceneFlat[k]?.path, name: sceneFlat[k]?.name }))
	},
	summary
};

// Workflow D entry in flags
if (screenshotPath) {
	flags.push({
		scenePath: [],
		code: 'VISUAL_DIFF_DEFERRED',
		level: 'info',
		message: 'screenshot hook acknowledged; pixel comparison not implemented yet'
	});
}

// Emit reports
if (reportJsonPath) {
	writeFileSync(resolve(reportJsonPath), jsonReport(reportObj));
	console.error(`wrote JSON report to ${reportJsonPath}`);
}

console.log(mdDiffReport(reportObj));

// Emit patch JSON
if (patchOutPath) {
	const patches = diffs
		.filter(d => d.severity === 'patch')
		.map(d => ({ scenePath: d.scenePath, prop: d.prop, to: d.to }));
	writeFileSync(resolve(patchOutPath), JSON.stringify(patches, null, 2));
	console.error(`wrote ${patches.length} patches to ${patchOutPath}`);
}

// Auto-apply
if (autoApply) {
	if (summary.refused > 0) {
		console.error(`ABORT auto-apply: ${summary.refused} diffs marked 'refuse' (text scale or class change).`);
		process.exit(1);
	}
	const patches = diffs
		.filter(d => d.severity === 'patch')
		.map(d => ({ scenePath: d.scenePath, prop: d.prop, to: d.to }));
	if (patches.length === 0) {
		console.error('No patches to apply.');
		process.exit(0);
	}
	const patchTmp = patchOutPath || join(dirname(resolve(scenePath)), '.diff-patches.json');
	writeFileSync(patchTmp, JSON.stringify(patches, null, 2));
	// Dry first
	const applyPath = join(__dirname, 'apply-patch.mjs');
	const dryRes = spawnSync('node', [applyPath, resolve(scenePath), patchTmp, '--dry'], { encoding: 'utf8' });
	console.error(dryRes.stdout);
	if (dryRes.status !== 0) {
		console.error(`dry-run failed (exit ${dryRes.status}); aborting auto-apply`);
		process.exit(1);
	}
	const realRes = spawnSync('node', [applyPath, resolve(scenePath), patchTmp], { encoding: 'utf8' });
	console.error(realRes.stdout);
	if (realRes.status !== 0) {
		console.error(`apply failed (exit ${realRes.status})`);
		process.exit(realRes.status);
	}
}

process.exit(0);

// ---- helpers ----

function ensureWalkedFigma(path) {
	const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
	if (raw.layers) return raw;
	const walkerPath = join(__dirname, 'figma-walker.mjs');
	const res = spawnSync('node', [walkerPath, resolve(path)], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error(`failed to walk figma snapshot: ${res.stderr}`);
		process.exit(2);
	}
	return JSON.parse(res.stdout);
}

function loadSceneFlat(path) {
	const walkerPath = join(__dirname, 'scene-walker.mjs');
	const res = spawnSync('node', [walkerPath, resolve(path)], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error(`failed to walk scene: ${res.stderr}`);
		process.exit(2);
	}
	return JSON.parse(res.stdout);
}

function findSceneMatches(sceneFlat, figmaLayer) {
	const results = [];
	// Try by identifier (leaf name match)
	for (const [key, entry] of Object.entries(sceneFlat)) {
		if (entry.name === figmaLayer.identifier) {
			results.push({ key, entry, matchedBy: 'namePath', namePath: entry.namePath });
		}
	}
	return results;
}

function findByPath(sceneFlat, path) {
	for (const entry of Object.values(sceneFlat)) {
		if (Array.isArray(entry.path) && arrayEq(entry.path, path)) return entry;
	}
	return null;
}

function findEntryKey(sceneFlat, path) {
	for (const [k, entry] of Object.entries(sceneFlat)) {
		if (Array.isArray(entry.path) && arrayEq(entry.path, path)) return k;
	}
	return null;
}

function arrayEq(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function computeFigmaLocal(figmaLayer, figmaSnap) {
	// Walk parent chain to compute scene-local coords.
	const bbox = figmaLayer.bbox;
	if (!bbox) return { x: 0, y: 0 };
	let parentX = 0, parentY = 0;
	if (figmaLayer.parentPath) {
		const parent = figmaSnap.layers[figmaLayer.parentPath];
		if (parent?.bbox) {
			parentX = parent.bbox.x;
			parentY = parent.bbox.y;
		}
	} else if (figmaSnap.root?.bbox) {
		parentX = figmaSnap.root.bbox.x;
		parentY = figmaSnap.root.bbox.y;
	}
	return { x: bbox.x - parentX, y: bbox.y - parentY };
}

function extractTintFromFills(fills) {
	if (!Array.isArray(fills)) return null;
	for (const f of fills) {
		if (f?.type === 'SOLID' && f.visible !== false) {
			const c = f.color;
			if (!c) continue;
			const r = Math.round((c.r ?? 0) * 255);
			const g = Math.round((c.g ?? 0) * 255);
			const b = Math.round((c.b ?? 0) * 255);
			return (r << 16) | (g << 8) | b;
		}
	}
	return null;
}

function round(n, places = 2) {
	const m = Math.pow(10, places);
	return Math.round(n * m) / m;
}
