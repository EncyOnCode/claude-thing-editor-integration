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
import { resolve, join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mdDiffReport, jsonReport } from './shared/report-format.mjs';
import { readConnectMap, findMapping } from './shared/connect-map.mjs';
import { extendTokens, isLayoutManaged, isTextClass } from './shared/class-tokens.mjs';
import { loadRegistry } from './shared/project-class-registry.mjs';

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
const projectRoot = flagValue('--project');
const autoApply = flagPresent('--auto-apply');
const strict = flagPresent('--strict');
const thrPx = strict ? 0 : (Number(flagValue('--threshold-px')) || 1);
const thrScale = strict ? 0 : (Number(flagValue('--threshold-scale')) || 0.01);
const thrRotDeg = strict ? 0 : (Number(flagValue('--threshold-rot')) || 1);
const thrRotRad = (thrRotDeg * Math.PI) / 180;

if (!figmaPath || !scenePath) {
	console.error('usage: diff-snapshot.mjs --figma <snapshot.json> --scene <scene.json> [options] [--project <root>]');
	process.exit(2);
}

if (projectRoot) {
	try {
		extendTokens(loadRegistry(projectRoot));
	} catch (e) {
		console.error(`warn: failed to load class registry: ${e.message}`);
	}
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

// Engine snapshot metadata (gameSize, orientation) — separate from per-node
// data that scene-walker already merges. We read the snapshot file directly
// here to derive design-scale calibration; per-node `world`/`localEngine`/
// `resizeEngine` come through sceneFlat entries.
const engineMeta = loadEngineSnapshotMeta(projectRoot, scenePath);
const figmaRootFrame = findFigmaRootFrame(figmaSnap);
const designScale = (figmaRootFrame?.bbox?.width && engineMeta?.gameSize?.W)
	? engineMeta.gameSize.W / figmaRootFrame.bbox.width
	: 1;
const haveEngineTruth = !!engineMeta && !!figmaRootFrame;
if (haveEngineTruth) {
	console.error(`info: engine truth available — gameSize ${engineMeta.gameSize.W}×${engineMeta.gameSize.H}, figma frame ${figmaRootFrame.bbox.width}×${figmaRootFrame.bbox.height}, designScale ${designScale.toFixed(4)}`);
} else if (projectRoot) {
	console.error(`info: engine snapshot or figma root frame missing — falling back to naive computeFigmaLocal coord math`);
}

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

	// Coordinate diff. Two code paths:
	// (1) engine-truth: per-node `world.*` from snapshot — anchor-aware, scale-
	//     calibrated, respects Resizer/LayoutGroup-derived positions.
	// (2) naive computeFigmaLocal — parent-subtract heuristic, used as fallback
	//     when no engine snapshot is available. Inaccurate under Resizer or
	//     parent-scale chains.
	const positionDiffs = haveEngineTruth && sceneNode.world
		? diffPositionEngineTruth(figma, sceneNode, sceneFlat, figmaRootFrame, designScale, engineMeta, thrPx)
		: diffPositionNaive(figma, sceneNode, sceneProps, figmaSnap, thrPx);
	for (const d of positionDiffs) diffs.push(d);

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
	const applyPath = join(__dirname, 'apply-patch.mjs');
	const applyArgs = [applyPath, resolve(scenePath), patchTmp];
	if (projectRoot) applyArgs.push('--project', resolve(projectRoot));
	const dryRes = spawnSync('node', [...applyArgs, '--dry'], { encoding: 'utf8' });
	console.error(dryRes.stdout);
	if (dryRes.status !== 0) {
		console.error(`dry-run failed (exit ${dryRes.status}); aborting auto-apply`);
		process.exit(1);
	}
	const realRes = spawnSync('node', applyArgs, { encoding: 'utf8' });
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
	const walkerArgs = [walkerPath, resolve(path)];
	if (projectRoot) walkerArgs.push('--project', resolve(projectRoot));
	const res = spawnSync('node', walkerArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error(`failed to walk figma snapshot: ${res.stderr}`);
		process.exit(2);
	}
	return JSON.parse(res.stdout);
}

function loadSceneFlat(path) {
	const walkerPath = join(__dirname, 'scene-walker.mjs');
	const walkerArgs = [walkerPath, resolve(path)];
	if (projectRoot) walkerArgs.push('--project', resolve(projectRoot));
	const res = spawnSync('node', walkerArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
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

// Engine-truth coord diff. Compares Figma anchor-point (in design-frame-local
// space, scaled to engine pixels) against engine worldTransform.tx/ty. Patch
// target selection depends on parent class and self resize state:
//   - parent is layout-managed (LayoutGroup/Resizer/custom subclasses) → refuse
//     with hint to tune parent layout params
//   - self has canOverridePivotAndAnchor=true → emit normalizePosX/Y best-effort
//     patches (preserves existing normAnchor, shifts pixel offset)
//   - otherwise → emit local x/y patches: newLocal = oldLocal + worldDelta
//     (assumes parent has no scale/rotation chain; phase 2C generalizes)
function diffPositionEngineTruth(figma, sceneNode, sceneFlat, rootFrame, designScale, engineMeta, thrPx) {
	const out = [];
	const figmaBbox = figma.bbox;
	if (!figmaBbox) return out;

	const anchorX = sceneNode.localEngine?.anchor?.x ?? 0;
	const anchorY = sceneNode.localEngine?.anchor?.y ?? 0;
	const figmaAnchorPointX = (figmaBbox.x - rootFrame.bbox.x) + figmaBbox.width * anchorX;
	const figmaAnchorPointY = (figmaBbox.y - rootFrame.bbox.y) + figmaBbox.height * anchorY;
	const targetWorldX = figmaAnchorPointX * designScale;
	const targetWorldY = figmaAnchorPointY * designScale;
	const currentWorldX = sceneNode.world.x;
	const currentWorldY = sceneNode.world.y;
	const deltaX = targetWorldX - currentWorldX;
	const deltaY = targetWorldY - currentWorldY;

	const parentEntry = findParentSceneEntry(sceneFlat, sceneNode.path);
	const parentLayoutManaged = parentEntry ? isLayoutManaged(parentEntry.class) : false;
	const canOverride = !!sceneNode.resizeEngine?.canOverridePivotAndAnchor;

	const reason = (axis, target, current) =>
		`engine-truth: figma anchor-point ${axis}=${round(axis === 'x' ? figmaAnchorPointX : figmaAnchorPointY)} (×${designScale.toFixed(4)} → ${round(target)}); engine world ${axis}=${round(current)}; Δ=${round(target - current)}px`;

	if (parentLayoutManaged) {
		if (Math.abs(deltaX) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'x',
				from: sceneNode.localEngine?.x ?? 0,
				to: null,
				delta: round(deltaX),
				severity: 'refuse',
				reason: reason('x', targetWorldX, currentWorldX),
				hint: `parent "${parentEntry.class}" overwrites child x in layoutChildren(); tune parent spacingX / paddingLeft / aligmentX instead`
			});
		}
		if (Math.abs(deltaY) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'y',
				from: sceneNode.localEngine?.y ?? 0,
				to: null,
				delta: round(deltaY),
				severity: 'refuse',
				reason: reason('y', targetWorldY, currentWorldY),
				hint: `parent "${parentEntry.class}" overwrites child y in layoutChildren(); tune parent spacingY / paddingTop / aligmentY instead`
			});
		}
		return out;
	}

	if (canOverride) {
		// Resizer engine formula (resize-attrib.ts): targetWorldPos =
		// parentWorldOrigin + parentSize × normAnchor + normalizePos.
		// useWorld=true means parentSize references game.W/H instead of parent bounds.
		const useWorld = !!sceneNode.resizeEngine?.useWorld;
		const parentWorldX = parentEntry?.world?.x ?? 0;
		const parentWorldY = parentEntry?.world?.y ?? 0;
		// Engine's resize formula references the parent's OWN width/height, not
		// its recursive subtree bounds. Engine snapshot now exports localEngine
		// .width/.height for containers that have it. Fallback chain:
		//   1. parent.localEngine.width (engine-truth own width)
		//   2. parent.props.width (authored)
		//   3. parent.localEngine.pivot.x × 2 (heuristic: SizedContainer pivot
		//      defaults to center, so center × 2 ≈ width)
		//   4. game.W (when useWorld=true OR all else fails)
		const parentWidth = useWorld
			? engineMeta.gameSize.W
			: (parentEntry?.localEngine?.width
				?? parentEntry?.props?.width
				?? (parentEntry?.localEngine?.pivotX != null ? parentEntry.localEngine.pivotX * 2 : null)
				?? engineMeta.gameSize.W);
		const parentHeight = useWorld
			? engineMeta.gameSize.H
			: (parentEntry?.localEngine?.height
				?? parentEntry?.props?.height
				?? (parentEntry?.localEngine?.pivotY != null ? parentEntry.localEngine.pivotY * 2 : null)
				?? engineMeta.gameSize.H);
		const normAnchorX = sceneNode.resizeEngine?.normAnchorX ?? 0;
		const normAnchorY = sceneNode.resizeEngine?.normAnchorY ?? 0;
		const newNormalizePosX = (targetWorldX - parentWorldX) - parentWidth * normAnchorX;
		const newNormalizePosY = (targetWorldY - parentWorldY) - parentHeight * normAnchorY;
		const curNormalizePosX = sceneNode.props?.normalizePosX ?? 0;
		const curNormalizePosY = sceneNode.props?.normalizePosY ?? 0;

		if (Math.abs(deltaX) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'normalizePosX',
				from: curNormalizePosX,
				to: round(newNormalizePosX),
				delta: round(newNormalizePosX - curNormalizePosX),
				severity: 'patch',
				reason: reason('x', targetWorldX, currentWorldX) +
					`; canOverride=true → patching normalizePosX (parentW=${round(parentWidth)}, normAnchorX=${normAnchorX})`,
				confidence: useWorld ? 'high' : 'approximate'
			});
		}
		if (Math.abs(deltaY) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'normalizePosY',
				from: curNormalizePosY,
				to: round(newNormalizePosY),
				delta: round(newNormalizePosY - curNormalizePosY),
				severity: 'patch',
				reason: reason('y', targetWorldY, currentWorldY) +
					`; canOverride=true → patching normalizePosY (parentH=${round(parentHeight)}, normAnchorY=${normAnchorY})`,
				confidence: useWorld ? 'high' : 'approximate'
			});
		}
		return out;
	}

	// Plain x/y patch on local coords. Assumes parent has no scale/rotation chain.
	const currentLocalX = sceneNode.localEngine?.x ?? sceneNode.props?.x ?? 0;
	const currentLocalY = sceneNode.localEngine?.y ?? sceneNode.props?.y ?? 0;
	const newLocalX = currentLocalX + deltaX;
	const newLocalY = currentLocalY + deltaY;

	if (Math.abs(deltaX) > thrPx) {
		out.push({
			scenePath: sceneNode.path,
			prop: 'x',
			from: sceneNode.props?.x ?? 0,
			to: round(newLocalX),
			delta: round(deltaX),
			severity: 'patch',
			reason: reason('x', targetWorldX, currentWorldX)
		});
	}
	if (Math.abs(deltaY) > thrPx) {
		const isCenterCenterText = isTextClass(sceneNode.class) && figma.style?.textAlignVertical === 'CENTER';
		out.push({
			scenePath: sceneNode.path,
			prop: 'y',
			from: sceneNode.props?.y ?? 0,
			to: round(newLocalY),
			delta: round(deltaY),
			severity: isCenterCenterText ? 'skip' : 'patch',
			reason: isCenterCenterText
				? 'Text center/center Y derivation unreliable from Figma — verify visually'
				: reason('y', targetWorldY, currentWorldY)
		});
	}
	return out;
}

// Legacy naive coord math. Kept for projects without an engine snapshot.
function diffPositionNaive(figma, sceneNode, sceneProps, figmaSnap, thrPx) {
	const out = [];
	const sceneX = sceneProps.x ?? 0;
	const sceneY = sceneProps.y ?? 0;
	const figmaLocal = computeFigmaLocal(figma, figmaSnap);
	if (Math.abs(sceneX - figmaLocal.x) > thrPx) {
		out.push({
			scenePath: sceneNode.path,
			prop: 'x',
			from: sceneX,
			to: round(figmaLocal.x),
			delta: round(figmaLocal.x - sceneX),
			severity: 'patch',
			reason: `naive: figma local x = ${round(figmaLocal.x)}, scene = ${sceneX} (engine snapshot unavailable)`
		});
	}
	if (Math.abs(sceneY - figmaLocal.y) > thrPx) {
		const isCenterCenterText = isTextClass(sceneNode.class) && figma.style?.textAlignVertical === 'CENTER';
		out.push({
			scenePath: sceneNode.path,
			prop: 'y',
			from: sceneY,
			to: round(figmaLocal.y),
			delta: round(figmaLocal.y - sceneY),
			severity: isCenterCenterText ? 'skip' : 'patch',
			reason: isCenterCenterText
				? 'Text center/center Y derivation unreliable from Figma — verify visually'
				: `naive: figma local y = ${round(figmaLocal.y)}, scene = ${sceneY} (engine snapshot unavailable)`
		});
	}
	return out;
}

function findFigmaRootFrame(figmaSnap) {
	if (figmaSnap?.root?.bbox) return figmaSnap.root;
	const layers = figmaSnap?.layers ?? {};
	for (const layer of Object.values(layers)) {
		if (!layer.parentPath && layer.bbox) return layer;
	}
	// Fallback: shortest-path layer with a bbox.
	let best = null;
	for (const layer of Object.values(layers)) {
		if (!layer.bbox) continue;
		if (!best || (layer.path?.length ?? 0) < (best.path?.length ?? Infinity)) best = layer;
	}
	return best;
}

function loadEngineSnapshotMeta(projectRoot, sceneFile) {
	if (!projectRoot || !sceneFile) return null;
	const sceneName = basename(sceneFile).replace(/\.(s|p)\.json$/, '');
	const path = join(resolve(projectRoot), '.thing-editor-meta', 'snapshots', sceneName + '.json');
	if (!existsSync(path)) return null;
	try {
		const snap = JSON.parse(readFileSync(path, 'utf8'));
		return {
			gameSize: snap.gameSize,
			orientation: snap.orientation,
			generatedAt: snap.generatedAt
		};
	} catch {
		return null;
	}
}

function findParentSceneEntry(sceneFlat, scenePath) {
	if (!scenePath || scenePath.length < 2) return null;
	const parentPath = scenePath.slice(0, -2);
	for (const entry of Object.values(sceneFlat)) {
		if (Array.isArray(entry.path) && arrayEq(entry.path, parentPath)) return entry;
	}
	return null;
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
