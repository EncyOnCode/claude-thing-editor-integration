#!/usr/bin/env node
// Workflow B: validate Figma layer naming against [Class] name convention.
// Soft enforcement — never blocks; surfaces issues with rule codes.
//
// Usage:
//   node naming-validator.mjs --figma <snapshot.json> [--scene <scene.json>] [--project <path>] [--json <out.json>]
//
// Exit codes: 0 (info only), 1 (warn), 2 (error).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLASS_TOKENS, extendTokens, getTokenSpec } from './shared/class-tokens.mjs';
import { parseLayerName, validateMeta } from './shared/figma-classify.mjs';
import { loadRegistry } from './shared/project-class-registry.mjs';
import { mdValidatorReport, summarizeFindings } from './shared/report-format.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}

const figmaPath = flagValue('--figma');
const scenePath = flagValue('--scene');
const projectRoot = flagValue('--project');
const jsonOut = flagValue('--json');

if (!figmaPath) {
	console.error('usage: naming-validator.mjs --figma <snapshot.json> [--scene <scene.json>] [--project <path>] [--json <out.json>]');
	process.exit(1);
}

// Register custom class tokens before walking the figma snapshot. Without this,
// [CardItem]/[AnimatedLayoutGroup]/etc would emit N002 "unknown token". Also
// forwarded to the figma-walker subprocess so its classifyErrors agree.
if (projectRoot) {
	try {
		extendTokens(loadRegistry(projectRoot));
	} catch (e) {
		console.error(`warn: failed to load class registry: ${e.message}`);
	}
}

const figmaSnap = ensureWalkedSnapshot(figmaPath);
const sceneFlat = scenePath ? loadSceneFlat(scenePath) : null;

const findings = [];
let scanned = 0;
let skipped = 0;

// Collect duplicates per parent
const dupesByParent = new Map(); // parentPath -> Map(identifier -> [paths])
const dupesGlobal = new Map(); // identifier -> [paths]

// Pre-pass: detect duplicates
for (const layer of Object.values(figmaSnap.layers || {})) {
	if (layer.skip) continue;
	const ident = layer.identifier;
	if (!ident) continue;
	const parent = layer.parentPath || '<root>';
	if (!dupesByParent.has(parent)) dupesByParent.set(parent, new Map());
	const p = dupesByParent.get(parent);
	if (!p.has(ident)) p.set(ident, []);
	p.get(ident).push(layer.path);

	if (!dupesGlobal.has(ident)) dupesGlobal.set(ident, []);
	dupesGlobal.get(ident).push(layer.path);
}

// Main pass
for (const layer of Object.values(figmaSnap.layers || {})) {
	if (layer.skip) { skipped++; continue; }
	scanned++;

	// Convert parse errors → findings
	for (const e of (layer.classifyErrors || [])) {
		findings.push({
			severity: e.code === 'N002' || e.code === 'N003' || e.code === 'N004' || e.code.startsWith('M00') ? 'error' : 'warn',
			code: e.code,
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: e.message
		});
	}

	// N001: auto-inferred class
	if (layer.inferredClass) {
		findings.push({
			severity: layer.inferredClass.confidence === 'low' ? 'warn' : 'warn',
			code: 'N001',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `no [Class] tag, inferred as ${layer.inferredClass.token} (${layer.inferredClass.confidence}: ${layer.inferredClass.reason})`
		});
	}

	// M-series: meta validation (skip special tokens that don't have meta requirements)
	if (layer.classTag && layer.classTag !== 'ref' && layer.classTag !== 'Prefab') {
		// Special tokens are handled separately; otherwise validate against tokenSpec
		const spec = getTokenSpec(layer.classTag);
		if (spec) {
			const metaErrors = validateMeta(layer.classTag, layer.meta || {}, spec);
			for (const e of metaErrors) {
				findings.push({
					severity: e.code === 'M004' ? 'warn' : 'error',
					code: e.code,
					figmaPath: layer.path,
					figmaNodeId: layer.id,
					message: e.message
				});
			}
		}
	}

	// N006: duplicate within parent
	const parent = layer.parentPath || '<root>';
	const parentMap = dupesByParent.get(parent);
	if (layer.identifier && parentMap && parentMap.get(layer.identifier).length > 1) {
		const others = parentMap.get(layer.identifier).filter(p => p !== layer.path);
		// Only emit once per group: on first occurrence
		if (parentMap.get(layer.identifier)[0] === layer.path) {
			findings.push({
				severity: 'error',
				code: 'N006',
				figmaPath: layer.path,
				figmaNodeId: layer.id,
				message: `duplicate within parent "${parent}" (also at ${others.join(', ')})`
			});
		}
	} else if (layer.identifier && dupesGlobal.get(layer.identifier).length > 1) {
		// N007: duplicate across different parents
		if (dupesGlobal.get(layer.identifier)[0] === layer.path) {
			findings.push({
				severity: 'warn',
				code: 'N007',
				figmaPath: layer.path,
				figmaNodeId: layer.id,
				message: `name "${layer.identifier}" appears ${dupesGlobal.get(layer.identifier).length} times across different parents`
			});
		}
	}

	// P001: [Prefab] but no .p.json exists
	if (layer.classTag === 'Prefab' && projectRoot && layer.identifier) {
		const prefabFile = join(resolve(projectRoot), 'assets', 'prefabs', `${layer.identifier}.p.json`);
		if (!existsSync(prefabFile)) {
			findings.push({
				severity: 'error',
				code: 'P001',
				figmaPath: layer.path,
				figmaNodeId: layer.id,
				message: `[Prefab] ${layer.identifier} — ${prefabFile} not found`
			});
		}
	}

	// P002: COMPONENT_SET not in figma.connect.json
	if (layer.type === 'COMPONENT_SET' && layer.componentSetId) {
		findings.push({
			severity: 'warn',
			code: 'P002',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `Figma COMPONENT_SET ${layer.componentSetId} not yet mapped in figma.connect.json`
		});
	}

	// P003: INSTANCE matched via componentId
	if (layer.componentId) {
		findings.push({
			severity: 'info',
			code: 'P003',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `INSTANCE matched via componentId ${layer.componentId}`
		});
	}

	// R001: [ref] foo — must exist in scene
	if (layer.classTag === 'ref' && layer.identifier) {
		if (sceneFlat) {
			const exists = Object.values(sceneFlat).some(s => s.name === layer.identifier);
			if (!exists) {
				findings.push({
					severity: 'error',
					code: 'R001',
					figmaPath: layer.path,
					figmaNodeId: layer.id,
					message: `[ref] ${layer.identifier} — no child named "${layer.identifier}" found in scene`
				});
			}
		} else {
			findings.push({
				severity: 'info',
				code: 'R001',
				figmaPath: layer.path,
				figmaNodeId: layer.id,
				message: `[ref] ${layer.identifier} — cannot verify (no --scene provided)`
			});
		}
	}

	// S001: unsupported constructs
	if (['BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'REGULAR_POLYGON'].includes(layer.type)) {
		findings.push({
			severity: 'warn',
			code: 'S001',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `unsupported ${layer.type} — will become Sprite-export TODO`
		});
	}

	// S002: filter effects
	if (Array.isArray(layer.effects) && layer.effects.some(e => e?.type === 'DROP_SHADOW' || e?.type === 'LAYER_BLUR')) {
		findings.push({
			severity: 'warn',
			code: 'S002',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `filter effect detected — can map to DropShadowFilter or BlurFilter`
		});
	}

	// T001: [Text] center/center Y unreliable
	if (layer.classTag === 'Text' && layer.meta?.vAlign === 'center' && layer.meta?.align === 'center') {
		findings.push({
			severity: 'warn',
			code: 'T001',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `Text center/center Y position derivation from Figma is unreliable (line height ≠ glyph bbox)`
		});
	}

	// T002: BitmapText font not found
	if (layer.classTag === 'BitmapText' && layer.meta?.font && projectRoot) {
		const fontDir = join(resolve(projectRoot), 'assets', 'fonts');
		const fontExists = existsSync(join(fontDir, `${layer.meta.font}.fnt`)) || existsSync(join(fontDir, `${layer.meta.font}.xml`));
		if (!fontExists) {
			findings.push({
				severity: 'warn',
				code: 'T002',
				figmaPath: layer.path,
				figmaNodeId: layer.id,
				message: `BitmapText font "${layer.meta.font}" not found in assets/fonts/`
			});
		}
	}

	// O001: OrientationTrigger
	if (layer.classTag === 'OrientationTrigger') {
		findings.push({
			severity: 'info',
			code: 'O001',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `OrientationTrigger detected with mode=${layer.meta?.mode}`
		});
	}

	// C001: Scene nested
	if (layer.classTag === 'Scene' && layer.parentPath) {
		findings.push({
			severity: 'error',
			code: 'C001',
			figmaPath: layer.path,
			figmaNodeId: layer.id,
			message: `[Scene] must be top-level; cannot be nested inside ${layer.parentPath}`
		});
	}
}

const summary = summarizeFindings(findings);

const reportObj = {
	figma: { fileKey: figmaSnap.fileKey, nodeId: figmaSnap.nodeId },
	scanned, skipped,
	findings,
	summary
};

if (jsonOut) {
	writeFileSync(resolve(jsonOut), JSON.stringify(reportObj, null, 2));
	console.error(`wrote JSON report to ${jsonOut}`);
}

// Always emit human-readable report to stdout.
console.log(mdValidatorReport(findings, {
	fileKey: figmaSnap.fileKey,
	nodeId: figmaSnap.nodeId,
	scanned, skipped
}));

process.exit(summary.exitCode);

// ---- helpers ----

function ensureWalkedSnapshot(path) {
	// Accept either a pre-walked snapshot (has `.layers`) or a raw Figma tree.
	const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
	if (raw.layers) return raw;
	const walkerPath = join(__dirname, 'figma-walker.mjs');
	const walkerArgs = [walkerPath, resolve(path)];
	if (projectRoot) walkerArgs.push('--project', resolve(projectRoot));
	const res = spawnSync('node', walkerArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error(`failed to walk figma snapshot: ${res.stderr}`);
		process.exit(1);
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
		return null;
	}
	return JSON.parse(res.stdout);
}
