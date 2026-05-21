#!/usr/bin/env node
// Top-level orchestrator. Reads <project>/figma.sync.json (scene → Figma node
// mapping), iterates each scene: opens it in the running editor via the
// command channel, exports snapshot+screenshot, fetches Figma frame, runs
// diff, optionally applies high-confidence patches, re-exports for SSIM
// verification, emits a per-scene report.
//
// Usage:
//   node figma-sync.mjs --project <path> [--scene <name>] [--apply]
//                       [--threshold 0.95] [--ssim-region-threshold 0.85]
//                       [--out-report <path.json>] [--auto-confidence high|medium|low]
//
// Requires:
//   - Editor open on <project>
//   - FIGMA_TOKEN env var
//   - <project>/figma.sync.json with at least { fileKey, scenes: {...} }

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportSceneViaCommand, openSceneViaCommand } from './shared/command-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const projectRoot = flagValue('--project');
const onlyScene = flagValue('--scene');
const apply = flagPresent('--apply');
const threshold = Number(flagValue('--threshold') ?? '0.95');
const regionThreshold = Number(flagValue('--ssim-region-threshold') ?? '0.85');
const outReport = flagValue('--out-report');
const autoConfidence = flagValue('--auto-confidence') ?? 'high'; // high | medium | low

if (!projectRoot) {
	console.error('usage: figma-sync.mjs --project <path> [--scene <name>] [--apply] [--threshold 0.95]');
	process.exit(2);
}
if (!process.env.FIGMA_TOKEN) {
	console.error('error: FIGMA_TOKEN env var required');
	process.exit(2);
}

const projectAbs = resolve(projectRoot);
const syncConfigPath = join(projectAbs, 'figma.sync.json');
if (!existsSync(syncConfigPath)) {
	console.error(`error: ${syncConfigPath} not found. Run scaffold-figma-sync.mjs first.`);
	process.exit(2);
}

const syncConfig = JSON.parse(readFileSync(syncConfigPath, 'utf8'));
if (!syncConfig.fileKey || !syncConfig.scenes) {
	console.error('error: figma.sync.json must contain fileKey + scenes');
	process.exit(2);
}

const confidenceRank = { high: 0, namePath: 0, connectMap: 1, medium: 1, pathSuffix: 1, low: 2, fuzzyLeaf: 2, bbox: 3 };
const autoConfidenceCutoff = { high: 0, medium: 1, low: 3 }[autoConfidence] ?? 0;

const sceneEntries = Object.entries(syncConfig.scenes).filter(([name]) => !onlyScene || name === onlyScene);
if (sceneEntries.length === 0) {
	console.error(`error: no matching scenes in figma.sync.json (--scene ${onlyScene})`);
	process.exit(2);
}

const report = {
	project: projectAbs,
	startedAt: new Date().toISOString(),
	scenes: [],
	summary: { total: 0, pass: 0, drift: 0, error: 0 }
};

function runNode(scriptRelPath, scriptArgs, opts = {}) {
	const scriptPath = join(__dirname, scriptRelPath);
	const res = spawnSync('node', [scriptPath, ...scriptArgs], {
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
		env: process.env,
		...opts
	});
	return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

for (const [sceneName, sceneCfg] of sceneEntries) {
	console.error(`\n=== scene: ${sceneName} (figma node ${sceneCfg.nodeId}) ===`);
	const sceneReport = { name: sceneName, nodeId: sceneCfg.nodeId, status: 'pending', steps: [] };
	report.scenes.push(sceneReport);

	try {
		// 1. Make sure the scene is open + freshly exported.
		console.error('-> opening + exporting via command channel');
		await openSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });
		const exportRes = await exportSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });
		sceneReport.steps.push({ step: 'export-initial', ok: true, paths: exportRes });

		// 2. Fetch figma JSON + PNG.
		console.error('-> fetching Figma data');
		const figmaJsonPath = `/tmp/figma-sync-${sceneName}.json`;
		const figmaPngPath = `/tmp/figma-sync-${sceneName}.png`;
		// fetch-figma.mjs URL regex needs a non-empty path segment after the
		// fileKey (matches the slug Figma puts there for shareable URLs).
		const figmaUrl = `https://www.figma.com/design/${syncConfig.fileKey}/proj?node-id=${sceneCfg.nodeId.replace(':', '-')}`;

		const fetchJson = runNode('fetch-figma.mjs', ['--url', figmaUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
		if (fetchJson.code !== 0) throw new Error(`fetch-figma failed: ${fetchJson.stderr}`);
		writeFileSync(figmaJsonPath, fetchJson.stdout);

		const fetchPng = runNode('fetch-figma-image.mjs', ['--url', figmaUrl, '--out', figmaPngPath]);
		if (fetchPng.code !== 0) throw new Error(`fetch-figma-image failed: ${fetchPng.stderr}`);
		sceneReport.steps.push({ step: 'fetch-figma', ok: true });

		// 3. Walk figma + scene.
		console.error('-> walking figma + scene');
		const figmaWalkedPath = `/tmp/figma-walked-${sceneName}.json`;
		const walkFigma = runNode('figma-walker.mjs', [figmaJsonPath, '--project', projectAbs, '--json', figmaWalkedPath]);
		if (walkFigma.code !== 0) throw new Error(`figma-walker failed: ${walkFigma.stderr}`);

		const scenePath = join(projectAbs, 'assets', sceneName + '.s.json');
		const sceneFlatPath = `/tmp/scene-flat-${sceneName}.json`;
		const walkScene = runNode('scene-walker.mjs', [scenePath, '--project', projectAbs], { stdio: ['ignore', 'pipe', 'pipe'] });
		if (walkScene.code !== 0) throw new Error(`scene-walker failed: ${walkScene.stderr}`);
		writeFileSync(sceneFlatPath, walkScene.stdout);

		// 4. Diff + emit patches.
		console.error('-> running diff');
		const patchesPath = `/tmp/patches-${sceneName}.json`;
		const diffReportPath = `/tmp/diff-report-${sceneName}.json`;
		const diff = runNode('diff-snapshot.mjs', [
			'--figma', figmaWalkedPath,
			'--scene', scenePath,
			'--project', projectAbs,
			'--patch-out', patchesPath,
			'--report-json', diffReportPath
		]);
		if (diff.code !== 0 && diff.code !== 1) throw new Error(`diff-snapshot failed: ${diff.stderr}`);
		const diffReport = JSON.parse(readFileSync(diffReportPath, 'utf8'));
		sceneReport.steps.push({ step: 'diff', ok: true, matched: diffReport.summary.matched, patches: diffReport.summary.patches });

		// 5. Optionally apply auto-confidence patches.
		let appliedCount = 0;
		if (apply && diffReport.diffs.length > 0) {
			const matchesByPath = new Map(diffReport.matches.map(m => [JSON.stringify(m.scenePath), m]));
			const toApply = diffReport.diffs.filter(d => {
				if (d.severity !== 'patch') return false;
				const m = matchesByPath.get(JSON.stringify(d.scenePath));
				const confLabel = m?.confidence ?? 'high';
				return (confidenceRank[confLabel] ?? 99) <= autoConfidenceCutoff;
			});
			if (toApply.length > 0) {
				const filteredPatchesPath = `/tmp/patches-auto-${sceneName}.json`;
				writeFileSync(filteredPatchesPath, JSON.stringify(toApply.map(d => ({ scenePath: d.scenePath, prop: d.prop, to: d.to })), null, 2));
				console.error(`-> applying ${toApply.length} auto-confidence patches`);
				const applyRes = runNode('apply-patch.mjs', [scenePath, filteredPatchesPath, '--project', projectAbs]);
				if (applyRes.code !== 0 && applyRes.code !== 2) throw new Error(`apply-patch failed: ${applyRes.stderr}`);
				appliedCount = toApply.length;

				// Re-export after apply so SSIM compares the new state.
				await openSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });
				await exportSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });

				// Re-walk for accurate region list.
				const reWalk = runNode('scene-walker.mjs', [scenePath, '--project', projectAbs], { stdio: ['ignore', 'pipe', 'pipe'] });
				writeFileSync(sceneFlatPath, reWalk.stdout);
			}
			sceneReport.steps.push({ step: 'apply', applied: appliedCount });
		}

		// 6. SSIM verification.
		console.error('-> running SSIM compare');
		const enginePng = join(projectAbs, '.thing-editor-meta', 'screenshots', sceneName + '.png');
		const diffPng = `/tmp/diff-${sceneName}.png`;
		const ssimThreshold = sceneCfg.ssimThreshold ?? threshold;
		const ssim = runNode('compare-screenshots.mjs', [
			'--engine', enginePng,
			'--figma', figmaPngPath,
			'--scene-flat', sceneFlatPath,
			'--output-diff', diffPng,
			'--threshold', String(ssimThreshold),
			'--region-threshold', String(regionThreshold)
		]);
		const ssimReport = ssim.stdout ? JSON.parse(ssim.stdout) : null;

		sceneReport.steps.push({ step: 'ssim', overall: ssimReport?.overallSsim, threshold: ssimThreshold, pass: ssim.code === 0 });
		sceneReport.ssim = ssimReport?.overallSsim ?? null;
		sceneReport.diffPath = diffPng;
		sceneReport.patches = diffReport.summary.patches;
		sceneReport.applied = appliedCount;
		sceneReport.status = ssim.code === 0 ? 'pass' : 'drift';
	} catch (e) {
		sceneReport.status = 'error';
		sceneReport.error = e?.message || String(e);
		console.error(`ERR ${sceneName}: ${sceneReport.error}`);
	}
}

report.summary.total = report.scenes.length;
report.summary.pass = report.scenes.filter(s => s.status === 'pass').length;
report.summary.drift = report.scenes.filter(s => s.status === 'drift').length;
report.summary.error = report.scenes.filter(s => s.status === 'error').length;
report.completedAt = new Date().toISOString();

console.error('\n=== summary ===');
for (const s of report.scenes) {
	const ssimStr = s.ssim != null ? s.ssim.toFixed(4) : 'n/a';
	console.error(`  ${s.status.padEnd(7)} ${s.name.padEnd(20)} ssim=${ssimStr} patches=${s.patches ?? 0} applied=${s.applied ?? 0}`);
}
console.error(`total=${report.summary.total} pass=${report.summary.pass} drift=${report.summary.drift} error=${report.summary.error}`);

if (outReport) {
	writeFileSync(resolve(outReport), JSON.stringify(report, null, 2));
	console.error(`wrote JSON report to ${outReport}`);
}

process.stdout.write(JSON.stringify(report, null, 2));
process.exit(report.summary.error > 0 ? 2 : (report.summary.drift > 0 ? 1 : 0));
