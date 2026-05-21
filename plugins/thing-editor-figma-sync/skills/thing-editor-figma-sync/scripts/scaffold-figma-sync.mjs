#!/usr/bin/env node
// First-run scaffolder for <project>/figma.sync.json. Lists scenes from
// thing-project.json + the project's assets/ tree, prompts (or accepts via
// --map) for Figma URL per scene, writes the config.
//
// Usage:
//   node scaffold-figma-sync.mjs --project <path> [--file-key <key>]
//      [--map scene1=<figma-url>,scene2=<figma-url>] [--merge] [--out <path>]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const projectRoot = flagValue('--project');
const fileKeyArg = flagValue('--file-key');
const mapArg = flagValue('--map');
const merge = flagPresent('--merge');
const outArg = flagValue('--out');

if (!projectRoot) {
	console.error('usage: scaffold-figma-sync.mjs --project <path> [--file-key <key>] [--map scene1=<figma-url>,...] [--merge]');
	process.exit(2);
}

const projectAbs = resolve(projectRoot);
const projConfigPath = join(projectAbs, 'thing-project.json');
if (!existsSync(projConfigPath)) {
	console.error(`error: ${projConfigPath} not found`);
	process.exit(2);
}

// Enumerate scenes by walking assets/ for *.s.json (mirrors fs.getAssetsList(SCENE)).
const assetsDir = join(projectAbs, 'assets');
const sceneNames = new Set();
function walk(dir) {
	if (!existsSync(dir)) return;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (!ent.name.startsWith('.') && ent.name !== 'node_modules') walk(p);
		} else if (ent.name.endsWith('.s.json')) {
			// scene assetName mirrors editor convention: relative path from assets/, .s.json suffix dropped.
			const rel = p.slice(assetsDir.length + 1);
			sceneNames.add(rel.replace(/\.s\.json$/, ''));
		}
	}
}
walk(assetsDir);

if (sceneNames.size === 0) {
	console.error('warn: no .s.json scenes found under assets/');
}

// Parse URL → { fileKey, nodeId } via the same regex fetch-figma uses.
function parseFigmaUrl(url) {
	const m = url.match(/figma\.com\/design\/([A-Za-z0-9]+)\/[^?]+\?.*node-id=([0-9]+-[0-9]+)/);
	if (!m) throw new Error(`cannot parse Figma URL: ${url}`);
	return { fileKey: m[1], nodeId: m[2].replace('-', ':') };
}

// Apply --map=scene1=<url>,scene2=<url>
const mapEntries = new Map();
if (mapArg) {
	for (const entry of mapArg.split(',')) {
		const eq = entry.indexOf('=');
		if (eq < 0) continue;
		mapEntries.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
	}
}

const outPath = outArg ? resolve(outArg) : join(projectAbs, 'figma.sync.json');
let existing = null;
if (merge && existsSync(outPath)) {
	existing = JSON.parse(readFileSync(outPath, 'utf8'));
}

let fileKey = fileKeyArg ?? existing?.fileKey ?? null;
const config = {
	version: 1,
	fileKey,
	scenes: existing?.scenes ?? {}
};

let added = 0;
let preserved = 0;
for (const scene of [...sceneNames].sort()) {
	const url = mapEntries.get(scene);
	if (config.scenes[scene] && !mapEntries.has(scene)) {
		preserved++;
		continue;
	}
	if (url) {
		const parsed = parseFigmaUrl(url);
		if (!config.fileKey) config.fileKey = parsed.fileKey;
		if (config.fileKey !== parsed.fileKey) {
			console.error(`warn: scene ${scene} maps to a different Figma file (${parsed.fileKey} vs config ${config.fileKey}); skipped`);
			continue;
		}
		config.scenes[scene] = {
			nodeId: parsed.nodeId,
			stateHint: config.scenes[scene]?.stateHint ?? 'default',
			ssimThreshold: config.scenes[scene]?.ssimThreshold ?? 0.85
		};
		added++;
	} else {
		// Stub the scene entry as TODO so the file shows up but doesn't run.
		if (!config.scenes[scene]) {
			config.scenes[scene] = {
				nodeId: null,
				stateHint: 'default',
				ssimThreshold: 0.85,
				todo: 'set nodeId before running figma-sync.mjs against this scene'
			};
		}
	}
}

if (!config.fileKey) {
	console.error('warn: no fileKey set; pass --file-key or include at least one --map entry');
}

writeFileSync(outPath, JSON.stringify(config, null, '\t'));
console.error(`wrote ${outPath}: ${Object.keys(config.scenes).length} scenes (${added} updated, ${preserved} preserved)`);
console.error(`scenes still missing nodeId: ${Object.entries(config.scenes).filter(([, v]) => !v.nodeId).map(([k]) => k).join(', ') || 'none'}`);
