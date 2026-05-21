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
const forceApply = flagPresent('--force-apply');
const revertScene = flagValue('--revert');
const revertAll = flagPresent('--revert-all');
const yes = flagPresent('--yes');
// Phase D defaults — gate thresholds. Per-scene override via figma.sync.json:
// `gateRatioDynamic` (number 0..1) and `gatePatchesProposed` (number).
const GATE_RATIO_DYNAMIC_DEFAULT = 0.5;
const GATE_PATCHES_PROPOSED_DEFAULT = 100;
const threshold = Number(flagValue('--threshold') ?? '0.95');
const regionThreshold = Number(flagValue('--ssim-region-threshold') ?? '0.85');
const outReport = flagValue('--out-report');
const autoConfidence = flagValue('--auto-confidence') ?? 'high'; // high | medium | low
// AI-gate inputs: regions matching --exclude-pattern get masked from SSIM.
// Typical use: "/(balance|score|name|avatar|userName|playerName|coin)/" to
// suppress dynamic-data drift on text/sprite leaves the engine fills at
// runtime. --exclude-class adds class-name filtering.
const excludePattern = flagValue('--exclude-pattern');
const excludeClass = flagValue('--exclude-class');

if (!projectRoot) {
	console.error('usage: figma-sync.mjs --project <path> [--scene <name>] [--apply | --force-apply] [--threshold 0.95]');
	console.error('       figma-sync.mjs --project <path> --revert <sceneName> [--yes]');
	console.error('       figma-sync.mjs --project <path> --revert-all [--yes]');
	process.exit(2);
}

// Phase E — revert mode runs before any Figma work. Bails the whole process
// without touching FIGMA_TOKEN / figma.sync.json validation paths.
if (revertScene || revertAll) {
	const projectAbsForRevert = resolve(projectRoot);
	const exitCode = runRevert(projectAbsForRevert, revertScene, revertAll, yes);
	process.exit(exitCode);
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

// Phase E — revert helper. Restores scene files to their git baseline. Refuses
// if the project is not a git repo or the scene isn't tracked. Requires --yes
// for the actual checkout step; without it, just prints what would be reverted.
function runRevert(projectAbs, sceneName, revertAllFlag, yesFlag) {
	const isRepo = spawnSync('git', ['-C', projectAbs, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
	if (isRepo.status !== 0) {
		console.error(`error: ${projectAbs} is not a git repo (or no git baseline). Cannot revert.`);
		return 2;
	}

	let configRaw;
	try {
		configRaw = readFileSync(join(projectAbs, 'figma.sync.json'), 'utf8');
	} catch {
		configRaw = null;
	}
	const cfg = configRaw ? JSON.parse(configRaw) : null;
	const sceneNames = revertAllFlag
		? (cfg?.scenes ? Object.keys(cfg.scenes) : [])
		: [sceneName];
	if (sceneNames.length === 0 || !sceneNames[0]) {
		console.error('error: --revert needs a scene name; --revert-all needs figma.sync.json with at least one scene listed.');
		return 2;
	}

	const targets = sceneNames.map(n => ({
		name: n,
		relPath: `assets/${n}.s.json`,
		absPath: join(projectAbs, 'assets', `${n}.s.json`)
	}));

	let touchedAny = false;
	for (const t of targets) {
		if (!existsSync(t.absPath)) {
			console.error(`  ${t.relPath}: file not found, skipping`);
			continue;
		}
		// Check if tracked.
		const lsTree = spawnSync('git', ['-C', projectAbs, 'ls-files', '--error-unmatch', t.relPath], { encoding: 'utf8' });
		if (lsTree.status !== 0) {
			console.error(`  ${t.relPath}: not tracked by git, skipping`);
			continue;
		}
		// Check if dirty.
		const diff = spawnSync('git', ['-C', projectAbs, 'diff', '--quiet', '--', t.relPath], { encoding: 'utf8' });
		if (diff.status === 0) {
			console.error(`  ${t.relPath}: clean, nothing to revert`);
			continue;
		}
		touchedAny = true;
		const stat = spawnSync('git', ['-C', projectAbs, 'diff', '--stat', '--', t.relPath], { encoding: 'utf8' });
		console.error(`  ${t.relPath}: ${(stat.stdout || '').trim().split('\n').pop()}`);
		if (yesFlag) {
			const checkout = spawnSync('git', ['-C', projectAbs, 'checkout', '--', t.relPath], { encoding: 'utf8' });
			if (checkout.status !== 0) {
				console.error(`    error: git checkout failed: ${checkout.stderr}`);
				return 1;
			}
			console.error(`    reverted to HEAD`);
		}
	}
	if (!touchedAny) {
		console.error('no scene files needed reverting.');
		return 0;
	}
	if (!yesFlag) {
		console.error('\ndry-run (no --yes). Re-run with --yes to actually revert.');
	}
	return 0;
}

// scene-walker args builder — forwards per-project dynamic-class names so the
// walker's isDynamic heuristic picks up project-specific patterns.
function sceneWalkerArgs(scenePath, projectAbs, sceneCfg) {
	const args = [scenePath, '--project', projectAbs];
	if (Array.isArray(sceneCfg?.dynamicClassPatterns) && sceneCfg.dynamicClassPatterns.length > 0) {
		args.push('--dynamic-classes', sceneCfg.dynamicClassPatterns.join(','));
	}
	return args;
}

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
		const walkScene = runNode('scene-walker.mjs', sceneWalkerArgs(scenePath, projectAbs, sceneCfg), { stdio: ['ignore', 'pipe', 'pipe'] });
		if (walkScene.code !== 0) throw new Error(`scene-walker failed: ${walkScene.stderr}`);
		writeFileSync(sceneFlatPath, walkScene.stdout);

		// 4. Diff + emit patches.
		console.error('-> running diff');
		const patchesPath = `/tmp/patches-${sceneName}.json`;
		const diffReportPath = `/tmp/diff-report-${sceneName}.json`;
		const diffArgs = [
			'--figma', figmaWalkedPath,
			'--scene', scenePath,
			'--project', projectAbs,
			'--patch-out', patchesPath,
			'--report-json', diffReportPath
		];
		// Per-scene exclusion rules (Phase A) — user-authored in figma.sync.json.
		// excludeClasses → comma-joined for the diff-snapshot CLI shape.
		// excludePatterns → joined into a single (a|b|c) regex for the single
		// --exclude-pattern arg the existing CLI accepts.
		// excludeScenePathPrefixes → JSON-stringified array-of-arrays.
		if (Array.isArray(sceneCfg.excludeClasses) && sceneCfg.excludeClasses.length > 0) {
			diffArgs.push('--exclude-class', sceneCfg.excludeClasses.join(','));
		}
		if (Array.isArray(sceneCfg.excludePatterns) && sceneCfg.excludePatterns.length > 0) {
			const combined = sceneCfg.excludePatterns
				.map(p => {
					// Allow either "/regex/flags" form or literal substring.
					const m = /^\/(.+)\/[a-z]*$/.exec(p);
					return m ? m[1] : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				})
				.map(p => `(?:${p})`)
				.join('|');
			diffArgs.push('--exclude-pattern', combined);
		}
		if (Array.isArray(sceneCfg.excludeScenePathPrefixes) && sceneCfg.excludeScenePathPrefixes.length > 0) {
			diffArgs.push('--exclude-scene-paths', JSON.stringify(sceneCfg.excludeScenePathPrefixes));
		}
		// Phase B — auto-exclude dynamic subtrees (default ON unless explicitly
		// disabled). scene-walker derives isDynamic per node from class chain +
		// prefabRef + parent-layout-managed + name suffix heuristics.
		const autoExcludeDynamicEff = sceneCfg.autoExcludeDynamic !== false;
		if (autoExcludeDynamicEff) {
			diffArgs.push('--auto-exclude-dynamic');
		}
		const diff = runNode('diff-snapshot.mjs', diffArgs);
		if (diff.code !== 0 && diff.code !== 1) throw new Error(`diff-snapshot failed: ${diff.stderr}`);
		const diffReport = JSON.parse(readFileSync(diffReportPath, 'utf8'));
		sceneReport.steps.push({ step: 'diff', ok: true, matched: diffReport.summary.matched, patches: diffReport.summary.patches });

		// Phase D — drift profile + pre-apply gate. Refuses auto-apply on
		// projects where most matches look runtime-driven OR patch count is
		// huge. --force-apply overrides; the gate prints a human-readable
		// review prompt with the patch file path.
		const totalConsidered = (diffReport.summary.matched ?? 0) + (diffReport.summary.excluded ?? 0);
		const ratioDynamic = totalConsidered > 0 ? (diffReport.summary.excluded ?? 0) / totalConsidered : 0;
		const driftProfile = {
			totalMatches: diffReport.summary.matched ?? 0,
			excludedMatches: diffReport.summary.excluded ?? 0,
			patchesProposed: diffReport.summary.patches ?? 0,
			fuzzyMatches: diffReport.summary.fuzzyMatches ?? 0,
			ratioDynamic: Number(ratioDynamic.toFixed(3))
		};
		sceneReport.driftProfile = driftProfile;
		const gateRatio = sceneCfg.gateRatioDynamic ?? GATE_RATIO_DYNAMIC_DEFAULT;
		const gatePatches = sceneCfg.gatePatchesProposed ?? GATE_PATCHES_PROPOSED_DEFAULT;
		const gateTriggered = (driftProfile.ratioDynamic > gateRatio) ||
			(driftProfile.patchesProposed > gatePatches);
		const gateReasons = [];
		if (driftProfile.ratioDynamic > gateRatio) {
			gateReasons.push(`ratioDynamic=${driftProfile.ratioDynamic} > ${gateRatio}`);
		}
		if (driftProfile.patchesProposed > gatePatches) {
			gateReasons.push(`patchesProposed=${driftProfile.patchesProposed} > ${gatePatches}`);
		}
		if (apply && gateTriggered && !forceApply) {
			sceneReport.status = 'review-required';
			sceneReport.gateReasons = gateReasons;
			sceneReport.steps.push({ step: 'gate', triggered: true, reasons: gateReasons });
			console.error(`\n!!! REVIEW-REQUIRED: scene "${sceneName}" — skipping auto-apply for safety`);
			console.error(`    reasons: ${gateReasons.join('; ')}`);
			console.error(`    drift profile: ${JSON.stringify(driftProfile)}`);
			console.error(`    review patches: cat ${patchesPath} | jq '.'`);
			console.error(`    to apply anyway: re-run with --force-apply`);
			console.error(`    to exclude specific subtrees: add excludeClasses / excludePatterns / excludeScenePathPrefixes to figma.sync.json`);
		}

		// 5. Optionally apply auto-confidence patches.
		let appliedCount = 0;
		if (apply && diffReport.diffs.length > 0 && (!gateTriggered || forceApply)) {
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
				// Parse the "WROTE ...: N applied, X refused, Y type-rejected, Z skipped" footer.
				// On exit-2 (ABORT) the file isn't written — applied stays 0.
				const wroteMatch = /WROTE\s+\S+:\s+(\d+)\s+applied/.exec(applyRes.stdout || '');
				if (applyRes.code === 0 && wroteMatch) {
					appliedCount = Number(wroteMatch[1]);
				} else if (applyRes.code === 2) {
					appliedCount = 0;
					console.error(`   warn: apply-patch ABORTED (exit 2); scene file unchanged. See report flags.`);
				} else {
					appliedCount = toApply.length;
				}

				// Re-export after apply so SSIM compares the new state.
				await openSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });
				await exportSceneViaCommand(projectAbs, sceneName, { forceDiscard: true });

				// Re-walk for accurate region list.
				const reWalk = runNode('scene-walker.mjs', sceneWalkerArgs(scenePath, projectAbs, sceneCfg), { stdio: ['ignore', 'pipe', 'pipe'] });
				writeFileSync(sceneFlatPath, reWalk.stdout);
			}
			sceneReport.steps.push({ step: 'apply', applied: appliedCount });
		}

		// 6. SSIM verification.
		console.error('-> running SSIM compare');
		const enginePng = join(projectAbs, '.thing-editor-meta', 'screenshots', sceneName + '.png');
		const diffPng = `/tmp/diff-${sceneName}.png`;
		const ssimThreshold = sceneCfg.ssimThreshold ?? threshold;
		const ssimArgs = [
			'--engine', enginePng,
			'--figma', figmaPngPath,
			'--scene-flat', sceneFlatPath,
			'--output-diff', diffPng,
			'--threshold', String(ssimThreshold),
			'--region-threshold', String(regionThreshold)
		];
		if (excludePattern) ssimArgs.push('--exclude-pattern', excludePattern);
		if (excludeClass) ssimArgs.push('--exclude-class', excludeClass);
		const ssim = runNode('compare-screenshots.mjs', ssimArgs);
		const ssimReport = ssim.stdout ? JSON.parse(ssim.stdout) : null;

		sceneReport.steps.push({ step: 'ssim', overall: ssimReport?.overallSsim, threshold: ssimThreshold, pass: ssim.code === 0 });
		sceneReport.ssim = ssimReport?.overallSsim ?? null;
		sceneReport.diffPath = diffPng;
		sceneReport.patches = diffReport.summary.patches;
		sceneReport.applied = appliedCount;
		sceneReport.status = ssim.code === 0 ? 'pass' : 'drift';
		// Persist artifact paths so an external AI/LLM gate can read them on
		// the next pass: diff report (per-node deltas + match confidences),
		// SSIM report (per-region scores + excluded markers), screenshots,
		// scene-flat snapshot.
		sceneReport.artifacts = {
			diffReport: diffReportPath,
			ssimReport: ssimReport ? `/tmp/ssim-report-${sceneName}.json` : null,
			sceneFlat: sceneFlatPath,
			figmaWalked: figmaWalkedPath,
			enginePng,
			figmaPng: figmaPngPath,
			diffPng
		};
		if (ssimReport) {
			writeFileSync(sceneReport.artifacts.ssimReport, JSON.stringify(ssimReport, null, 2));
		}
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
