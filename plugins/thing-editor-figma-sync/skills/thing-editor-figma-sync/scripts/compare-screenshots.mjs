#!/usr/bin/env node
// Workflow D: visual verification via SSIM compare + pixel-delta overlay.
//
// Usage:
//   node compare-screenshots.mjs \
//     --engine <project>/.thing-editor-meta/screenshots/<scene>.png \
//     --figma  <fetched-figma-frame.png> \
//     [--output-diff <diff.png>] \
//     [--scene-flat <scene-walker-output.json>] \
//     [--threshold 0.95]                # SSIM pass threshold, default 0.95
//     [--region-threshold 0.85]         # per-region pass threshold
//
// Output: human-readable summary to stderr, JSON to stdout with shape
//   { overallSsim, mismatchedPixels, totalPixels, regions: [...], diffPath }
//
// Exit codes: 0 if overallSsim >= threshold, 1 otherwise. 2 on input errors.
//
// Dependencies (install via `npm install` in plugin dir):
//   pngjs, ssim.js

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

let PNG;
let ssim;
try {
	PNG = (await import('pngjs')).PNG;
	ssim = (await import('ssim.js')).ssim;
} catch (e) {
	console.error('error: missing dependencies. Run `npm install` in plugins/thing-editor-figma-sync/');
	console.error(`  underlying: ${e.message}`);
	process.exit(2);
}

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}

const enginePath = flagValue('--engine');
const figmaPath = flagValue('--figma');
const outputDiff = flagValue('--output-diff');
const sceneFlatPath = flagValue('--scene-flat');
const threshold = Number(flagValue('--threshold') ?? '0.95');
const regionThreshold = Number(flagValue('--region-threshold') ?? '0.85');
// Exclude regions from the SSIM compare. Two complementary modes:
//   --exclude-pattern <regex>  — JS regex tested against entry.namePath
//   --exclude-class <classes>  — comma list of class names (Trigger, MovieClip, etc.)
// When a region is excluded its bbox gets masked (filled black) in BOTH the
// engine and figma images before whole-image SSIM, so dynamic-state drift
// doesn't pollute the overall score. The per-region report marks
// excluded:true with the matched filter.
const excludePatternStr = flagValue('--exclude-pattern');
const excludeClassesStr = flagValue('--exclude-class');
const excludePattern = excludePatternStr ? new RegExp(excludePatternStr) : null;
const excludeClasses = excludeClassesStr ? new Set(excludeClassesStr.split(',').map(s => s.trim()).filter(Boolean)) : null;

if (!enginePath || !figmaPath) {
	console.error('usage: compare-screenshots.mjs --engine <png> --figma <png> [--output-diff <png>] [--scene-flat <json>] [--threshold 0.95] [--region-threshold 0.85] [--exclude-pattern <regex>] [--exclude-class <a,b>]');
	process.exit(2);
}
for (const p of [enginePath, figmaPath]) {
	if (!existsSync(resolve(p))) {
		console.error(`error: file not found: ${p}`);
		process.exit(2);
	}
}

function loadPng(path) {
	const buf = readFileSync(resolve(path));
	const png = PNG.sync.read(buf);
	return { width: png.width, height: png.height, data: png.data };
}

function ssimImageData(img) {
	// ssim.js expects { width, height, data: Uint8ClampedArray } in RGBA.
	return {
		width: img.width,
		height: img.height,
		data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength)
	};
}

const engineImg = loadPng(enginePath);
const figmaImg = loadPng(figmaPath);

const warnings = [];
if (engineImg.width !== figmaImg.width || engineImg.height !== figmaImg.height) {
	warnings.push(`dimension mismatch: engine ${engineImg.width}×${engineImg.height} vs figma ${figmaImg.width}×${figmaImg.height}.`);
	console.error(`error: ${warnings[0]}`);
	console.error('hint: regenerate figma export at the same scale as engine gameSize, or crop/rescale before comparing.');
	process.exit(2);
}

// Pre-compute list of excluded regions BEFORE the whole-image SSIM so we can
// black out their pixel zones first. Requires sceneFlat.
const wImg = engineImg.width;
const hImg = engineImg.height;
const excludedRegions = [];
if (sceneFlatPath && (excludePattern || excludeClasses)) {
	if (existsSync(resolve(sceneFlatPath))) {
		const sceneFlat = JSON.parse(readFileSync(resolve(sceneFlatPath), 'utf8'));
		for (const [namePath, entry] of Object.entries(sceneFlat)) {
			if (!entry.world?.bounds) continue;
			let matchReason = null;
			if (excludePattern && excludePattern.test(namePath)) matchReason = `pattern: /${excludePattern.source}/`;
			else if (excludeClasses && excludeClasses.has(entry.class)) matchReason = `class: ${entry.class}`;
			if (!matchReason) continue;
			const b = entry.world.bounds;
			const x = Math.max(0, Math.floor(b.x));
			const y = Math.max(0, Math.floor(b.y));
			const rw = Math.min(wImg - x, Math.ceil(b.width));
			const rh = Math.min(hImg - y, Math.ceil(b.height));
			if (rw <= 0 || rh <= 0) continue;
			excludedRegions.push({ namePath, class: entry.class, reason: matchReason, x, y, w: rw, h: rh });
		}
	} else {
		console.error(`warn: --scene-flat ${sceneFlatPath} missing; exclude flags ignored`);
	}
}

function fillBlack(img, x, y, w, h) {
	for (let row = 0; row < h; row++) {
		const start = ((y + row) * img.width + x) * 4;
		for (let i = 0; i < w * 4; i += 4) {
			img.data[start + i] = 0;
			img.data[start + i + 1] = 0;
			img.data[start + i + 2] = 0;
			img.data[start + i + 3] = 255;
		}
	}
}

for (const r of excludedRegions) {
	fillBlack(engineImg, r.x, r.y, r.w, r.h);
	fillBlack(figmaImg, r.x, r.y, r.w, r.h);
}
if (excludedRegions.length > 0) {
	console.error(`info: masked ${excludedRegions.length} excluded regions before whole-image SSIM`);
}

const { mssim } = ssim(ssimImageData(engineImg), ssimImageData(figmaImg));
const overallSsim = mssim;

// Build pixel-delta diff overlay alongside the SSIM number for human review.
const w = engineImg.width;
const h = engineImg.height;
const diffData = Buffer.alloc(w * h * 4);
let mismatchedPixels = 0;
for (let i = 0; i < w * h; i++) {
	const off = i * 4;
	const dr = Math.abs(engineImg.data[off] - figmaImg.data[off]);
	const dg = Math.abs(engineImg.data[off + 1] - figmaImg.data[off + 1]);
	const db = Math.abs(engineImg.data[off + 2] - figmaImg.data[off + 2]);
	const mag = Math.min(255, dr + dg + db);
	if (mag > 8) mismatchedPixels++; // ~1% sensitivity per channel
	const gray = Math.round((engineImg.data[off] + engineImg.data[off + 1] + engineImg.data[off + 2]) / 3 * 0.4);
	diffData[off] = mag > 8 ? 255 : gray;
	diffData[off + 1] = mag > 8 ? Math.max(0, gray - mag / 2) : gray;
	diffData[off + 2] = mag > 8 ? Math.max(0, gray - mag / 2) : gray;
	diffData[off + 3] = 255;
}

let diffPath = null;
if (outputDiff) {
	const out = new PNG({ width: w, height: h });
	diffData.copy(out.data);
	writeFileSync(resolve(outputDiff), PNG.sync.write(out));
	diffPath = resolve(outputDiff);
}

// Per-region SSIM when scene-walker flat-map is provided.
const regions = [];
if (sceneFlatPath) {
	if (!existsSync(resolve(sceneFlatPath))) {
		console.error(`warn: --scene-flat not found: ${sceneFlatPath}`);
	} else {
		const sceneFlat = JSON.parse(readFileSync(resolve(sceneFlatPath), 'utf8'));
		const entries = Object.entries(sceneFlat).filter(([, e]) =>
			e.engineVisible !== false &&
			e.world?.bounds &&
			e.class !== 'Resizer' &&
			e.class !== 'LayoutGroup' &&
			e.class !== 'LayoutGrid'
		);

		const excludedKey = new Map(excludedRegions.map(r => [r.namePath, r.reason]));
		for (const [namePath, entry] of entries) {
			const bbox = entry.world.bounds;
			const x = Math.max(0, Math.floor(bbox.x));
			const y = Math.max(0, Math.floor(bbox.y));
			const rw = Math.min(w - x, Math.ceil(bbox.width));
			const rh = Math.min(h - y, Math.ceil(bbox.height));
			if (rw < 4 || rh < 4) continue; // ssim.js requires min 4×4
			if (excludedKey.has(namePath)) {
				regions.push({
					namePath, class: entry.class,
					bbox: { x, y, w: rw, h: rh },
					ssim: null, mismatchPercent: 0, pass: true,
					excluded: true, excludeReason: excludedKey.get(namePath)
				});
				continue;
			}

			const engineCrop = cropRGBA(engineImg, x, y, rw, rh);
			const figmaCrop = cropRGBA(figmaImg, x, y, rw, rh);
			let regionSsim;
			try {
				regionSsim = ssim(ssimImageData(engineCrop), ssimImageData(figmaCrop)).mssim;
			} catch {
				regionSsim = null;
			}
			let regionMismatch = 0;
			for (let i = 0; i < rw * rh; i++) {
				const off = i * 4;
				const dr = Math.abs(engineCrop.data[off] - figmaCrop.data[off]);
				const dg = Math.abs(engineCrop.data[off + 1] - figmaCrop.data[off + 1]);
				const db = Math.abs(engineCrop.data[off + 2] - figmaCrop.data[off + 2]);
				if (dr + dg + db > 8) regionMismatch++;
			}
			// SSIM degenerates to 0 when both crops have zero variance (uniform
			// regions: alpha-transparent zones, blank backgrounds). The two
			// crops are visually identical — zero mismatched pixels — yet SSIM
			// reports total failure because its luma/contrast normalization
			// divides by ~0. Treat such cells as a pass (ssim=1) and flag them
			// for the JSON report so users can audit. Filtered out of the
			// stderr "top failures" listing to keep signal high.
			let degenerate = false;
			if (regionSsim != null && regionMismatch === 0 && regionSsim < 0.5) {
				degenerate = true;
				regionSsim = 1.0;
			}
			regions.push({
				namePath,
				class: entry.class,
				bbox: { x, y, w: rw, h: rh },
				ssim: regionSsim != null ? Number(regionSsim.toFixed(4)) : null,
				mismatchPercent: Number((regionMismatch / (rw * rh) * 100).toFixed(2)),
				pass: regionSsim != null ? regionSsim >= regionThreshold : false,
				degenerate
			});
		}
		regions.sort((a, b) => (a.ssim ?? 0) - (b.ssim ?? 0));
	}
}

const totalPixels = w * h;
const degenerateCount = regions.filter(r => r.degenerate).length;
const excludedCount = regions.filter(r => r.excluded).length;
const report = {
	overallSsim: Number(overallSsim.toFixed(4)),
	threshold,
	pass: overallSsim >= threshold,
	mismatchedPixels,
	totalPixels,
	mismatchPercent: Number((mismatchedPixels / totalPixels * 100).toFixed(2)),
	dimensions: { width: w, height: h },
	diffPath,
	regionThreshold,
	regions,
	regionsDegenerate: degenerateCount,
	regionsExcluded: excludedCount,
	warnings
};

console.error(`SSIM: ${report.overallSsim} (threshold ${threshold}, ${report.pass ? 'PASS' : 'FAIL'})`);
console.error(`pixel mismatch: ${mismatchedPixels} / ${totalPixels} (${report.mismatchPercent}%)`);
if (excludedCount > 0) console.error(`excluded regions: ${excludedCount} masked before SSIM`);
if (diffPath) console.error(`diff overlay: ${diffPath}`);
if (regions.length) {
	const failed = regions.filter(r => !r.pass && !r.degenerate && !r.excluded);
	const extras = [];
	if (degenerateCount) extras.push(`${degenerateCount} degenerate ssim=0 cells suppressed`);
	if (excludedCount) extras.push(`${excludedCount} excluded`);
	console.error(`regions: ${regions.length} scored, ${failed.length} below threshold ${regionThreshold}${extras.length ? ` (${extras.join(', ')})` : ''}`);
	for (const r of failed.slice(0, 10)) {
		console.error(`  FAIL ${r.namePath} (${r.class}) ssim=${r.ssim} mismatch=${r.mismatchPercent}%`);
	}
}

process.stdout.write(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);

function cropRGBA(img, x, y, w, h) {
	const data = Buffer.alloc(w * h * 4);
	for (let row = 0; row < h; row++) {
		const srcStart = ((y + row) * img.width + x) * 4;
		const dstStart = row * w * 4;
		img.data.copy(data, dstStart, srcStart, srcStart + w * 4);
	}
	return { width: w, height: h, data };
}
