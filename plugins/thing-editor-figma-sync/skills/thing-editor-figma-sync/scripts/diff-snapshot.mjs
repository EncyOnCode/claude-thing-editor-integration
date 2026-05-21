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
//     [--tokens <variables.json>] # Pattern A soft DS — variables from fetch-figma-vars.mjs
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
import { findSceneMatches } from './shared/match-strategy.mjs';
import {
	loadFigmaTokensConfig,
	loadFigmaVariables,
	resolveBoundVariable,
	findEngineMappingFor,
	normalizeHex
} from './shared/figma-tokens.mjs';

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
const tokensPath = flagValue('--tokens');
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

// Pattern A (soft) Design System support. Both inputs are opt-in:
//   --tokens <path>   variables JSON from fetch-figma-vars.mjs
//   <project>/figma.tokens.json   manual engine-side mapping
// When present, the diff emits DS_TOKEN_HINT info-level flags alongside raw
// tint/fontSize patches; raw patches themselves are unchanged.
let figmaVariables = null;
let tokensConfig = null;
if (tokensPath) {
	try {
		figmaVariables = loadFigmaVariables(tokensPath);
		console.error(`info: loaded ${Object.keys(figmaVariables.byId).length} Figma variables from ${tokensPath}`);
	} catch (e) {
		console.error(`warn: failed to load --tokens ${tokensPath}: ${e.message}`);
	}
}
if (projectRoot) {
	tokensConfig = loadFigmaTokensConfig(projectRoot);
	if (tokensConfig) {
		const total = Object.keys(tokensConfig.colors).length + Object.keys(tokensConfig.fontSizes).length + Object.keys(tokensConfig.textStyles).length;
		console.error(`info: loaded figma.tokens.json with ${total} mappings from ${tokensConfig._path}`);
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
// Two-pass: collect proposals first so we can resolve scene-key conflicts by
// confidence. Without this, two figma layers can claim the same scene entry
// and the second one's bbox produces noise diffs (e.g. a Frame overlapping
// "bet" hijacks bet's position diff from the actual "bet" figma layer).
const proposals = [];
for (const layer of Object.values(figmaSnap.layers)) {
	if (layer.skip) continue;
	if (!layer.identifier) {
		unmatchedFigma.push({ figmaId: layer.id, name: layer.name, type: layer.type });
		continue;
	}

	const cm = connectMap && findMapping(connectMap, { id: layer.id, componentSetId: layer.componentSetId });
	if (cm && cm.scenePath) {
		const cmEntry = findByPath(sceneFlat, cm.scenePath);
		const cmKey = findEntryKey(sceneFlat, cm.scenePath);
		proposals.push({
			layer,
			candidates: cmEntry ? [{ key: cmKey, entry: cmEntry, matchedBy: 'connectMap', confidence: 'connectMap', namePath: cmEntry.namePath }] : []
		});
		continue;
	}

	const candidates = findSceneMatches(sceneFlat, layer, figmaSnap, {
		designScale,
		engineMeta,
		figmaRootFrame
	});
	proposals.push({ layer, candidates });
}

// Resolve in two passes: first claim by high-confidence candidates (so they
// can't be hijacked by a later bbox match), then sweep remaining figma layers
// against unclaimed scene keys.
const claimedKeys = new Set();
const layerAssigned = new Map();

function claim(proposal) {
	for (const cand of proposal.candidates) {
		if (claimedKeys.has(cand.key)) continue;
		claimedKeys.add(cand.key);
		layerAssigned.set(proposal.layer.id, cand);
		return cand;
	}
	return null;
}

// Pass 1: high-confidence claims (namePath, connectMap, pathSuffix).
for (const p of proposals) {
	const top = p.candidates[0];
	if (!top) continue;
	if (top.confidence === 'high' || top.confidence === 'connectMap' || top.confidence === 'medium') {
		claim(p);
	}
}
// Pass 2: fall through to low-confidence (fuzzy, bbox).
for (const p of proposals) {
	if (layerAssigned.has(p.layer.id)) continue;
	claim(p);
}

// Materialize matches in figma-layer order.
for (const p of proposals) {
	const chosen = layerAssigned.get(p.layer.id);
	if (!chosen) {
		unmatchedFigma.push({ figmaId: p.layer.id, name: p.layer.name, type: p.layer.type });
		continue;
	}
	matches.push({
		figma: p.layer,
		scene: chosen.entry,
		matchedBy: chosen.matchedBy,
		confidence: chosen.confidence,
		namePath: chosen.namePath
	});
	if (chosen.confidence !== 'high') {
		const level = (chosen.confidence === 'low' || chosen.confidence === 'bbox') ? 'warn' : 'info';
		flags.push({
			scenePath: chosen.entry.path,
			code: 'MATCH_FUZZY',
			level,
			message: `Figma "${p.layer.name}" → scene "${chosen.namePath}" matched by ${chosen.matchedBy} (confidence ${chosen.confidence}${chosen.score != null ? `, score ${Number(chosen.score).toFixed(2)}` : ''})`
		});
	}
	unmatchedScene.delete(chosen.key);
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
		// Pattern A soft DS hint: if the figma layer's fill is bound to a
		// Variable, surface the variable name + engine-side mapping (if any).
		// We do NOT alter the patch — raw tint patch still applies.
		emitDSTokenHints(sceneNode, figma, 'fills', figmaTint);
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
			emitDSTokenHints(sceneNode, figma, 'fontSize', figma.style.fontSize);
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

// Engine-truth coord diff. Compares the rendered visual extent reported by
// the engine (sceneNode.world.bounds = Pixi getBounds() in world space — the
// same rectangle a player perceives) against the Figma layer's
// absoluteBoundingBox translated into engine pixels via designScale.
//
// Earlier iterations used `worldTransform.tx`/`.ty` for the engine side, but
// for Container / SizedContainer with non-zero pivot that point is the local
// (0,0) AFTER pivot offset — NOT the visual top-left. Bounds-to-bbox is a
// universal reference frame: for Sprite-with-anchor it equals
// (anchor-point − anchor × size); for plain Container it equals the rendered
// subtree extent. Both engine and Figma agree on this shape.
//
// Patch target selection (unchanged in spirit, but delta now derives from
// bounds):
//   - parent is layout-managed (LayoutGroup/Resizer/custom subclass) → refuse
//     with hint to tune parent layout params.
//   - self has canOverridePivotAndAnchor=true → shift normalizePosX/Y by
//     deltaX/Y; parentW × normAnchorX is fixed across the patch, so the
//     pixel offset is the full correction.
//   - otherwise → shift authored x/y by deltaX/Y; engine recomputes
//     worldTransform identically except for the translation, so bounds.x/y
//     move by the same delta.
function diffPositionEngineTruth(figma, sceneNode, sceneFlat, rootFrame, designScale, engineMeta, thrPx) {
	const out = [];
	const figmaBbox = figma.bbox;
	const engineBounds = sceneNode.world?.bounds;
	if (!figmaBbox || !engineBounds) return out;

	const figmaWorldX = (figmaBbox.x - rootFrame.bbox.x) * designScale;
	const figmaWorldY = (figmaBbox.y - rootFrame.bbox.y) * designScale;
	const currentWorldX = engineBounds.x;
	const currentWorldY = engineBounds.y;
	const deltaX = figmaWorldX - currentWorldX;
	const deltaY = figmaWorldY - currentWorldY;
	const targetWorldX = figmaWorldX;
	const targetWorldY = figmaWorldY;

	const parentEntry = findParentSceneEntry(sceneFlat, sceneNode.path);
	const parentLayoutManaged = parentEntry ? isLayoutManaged(parentEntry.class) : false;
	const canOverride = !!sceneNode.resizeEngine?.canOverridePivotAndAnchor;

	const reason = (axis, target, current) =>
		`engine-truth: figma bounds.${axis}=${round(axis === 'x' ? figmaWorldX : figmaWorldY)} (designScale ${designScale.toFixed(4)}); engine bounds.${axis}=${round(current)}; Δ=${round(target - current)}px`;

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
		// canOverridePivotAndAnchor=true means engine recomputes self.x/y each
		// frame as: self.x = parentW × normAnchorX + normalizePosX (mirror for
		// Y). Shifting normalizePosX by deltaX translates the container — and
		// therefore its world.bounds — by exactly deltaX. No parent-width
		// derivation is required.
		const curNormalizePosX = sceneNode.props?.normalizePosX ?? 0;
		const curNormalizePosY = sceneNode.props?.normalizePosY ?? 0;
		const newNormalizePosX = curNormalizePosX + deltaX;
		const newNormalizePosY = curNormalizePosY + deltaY;

		if (Math.abs(deltaX) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'normalizePosX',
				from: curNormalizePosX,
				to: round(newNormalizePosX),
				delta: round(deltaX),
				severity: 'patch',
				reason: reason('x', targetWorldX, currentWorldX) + '; canOverride=true → shifting normalizePosX'
			});
		}
		if (Math.abs(deltaY) > thrPx) {
			out.push({
				scenePath: sceneNode.path,
				prop: 'normalizePosY',
				from: curNormalizePosY,
				to: round(newNormalizePosY),
				delta: round(deltaY),
				severity: 'patch',
				reason: reason('y', targetWorldY, currentWorldY) + '; canOverride=true → shifting normalizePosY'
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

// Pattern A soft DS hint emitter. Inspects a figma layer's `boundVariables`
// for the given field (e.g. 'fills' for tint, 'fontSize' for text), resolves
// the variable to a name + value via the loaded variables map, and pushes a
// DS_TOKEN_HINT info-level flag into the shared `flags` array.
//
// Two branches:
//   - mapping found in figma.tokens.json → suggest the engine token path.
//   - no mapping → tell the user to run scaffold-tokens.mjs.
//
// Does NOT alter the diff patch — Pattern A is warnings-only.
function emitDSTokenHints(sceneNode, figmaLayer, field, rawValue) {
	if (!figmaVariables) return;
	if (!figmaLayer?.boundVariables) return;
	const bound = resolveBoundVariable(figmaLayer, figmaVariables);
	const matchingField = bound.filter(b => b.field === field);
	if (matchingField.length === 0) return;
	for (const b of matchingField) {
		if (!b.variableName) {
			flags.push({
				scenePath: sceneNode.path,
				code: 'DS_TOKEN_HINT',
				level: 'info',
				message: `Figma ${field} bound to variable id ${b.variableId} (name not resolvable; re-fetch variables JSON).`
			});
			continue;
		}
		const mapping = tokensConfig ? findEngineMappingFor(tokensConfig, b.variableName) : null;
		if (mapping && mapping.engineToken) {
			const rawHex = typeof rawValue === 'number' && field === 'fills'
				? `0x${rawValue.toString(16).padStart(6, '0')}`
				: String(rawValue);
			flags.push({
				scenePath: sceneNode.path,
				code: 'DS_TOKEN_HINT',
				level: 'info',
				message: `Figma ${field} bound to variable "${b.variableName}" → engine token "${mapping.engineToken}" available. Consider patching token reference instead of raw value ${rawHex}.`
			});
		} else {
			flags.push({
				scenePath: sceneNode.path,
				code: 'DS_TOKEN_HINT',
				level: 'info',
				message: tokensConfig
					? `Figma ${field} bound to variable "${b.variableName}" but no figma.tokens.json mapping. Add an "engineToken" entry under "${field === 'fills' ? 'colors' : 'fontSizes'}.${b.variableName}".`
					: `Figma ${field} bound to variable "${b.variableName}" but no figma.tokens.json mapping. Run scaffold-tokens.mjs.`
			});
		}
	}
}
