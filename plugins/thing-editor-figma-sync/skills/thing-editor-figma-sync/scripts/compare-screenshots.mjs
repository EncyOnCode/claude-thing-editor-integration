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

if (!enginePath || !figmaPath) {
	console.error('usage: compare-screenshots.mjs --engine <png> --figma <png> [--output-diff <png>] [--scene-flat <json>] [--threshold 0.95] [--region-threshold 0.85]');
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

		for (const [namePath, entry] of entries) {
			const bbox = entry.world.bounds;
			const x = Math.max(0, Math.floor(bbox.x));
			const y = Math.max(0, Math.floor(bbox.y));
			const rw = Math.min(w - x, Math.ceil(bbox.width));
			const rh = Math.min(h - y, Math.ceil(bbox.height));
			if (rw < 4 || rh < 4) continue; // ssim.js requires min 4×4

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
			regions.push({
				namePath,
				class: entry.class,
				bbox: { x, y, w: rw, h: rh },
				ssim: regionSsim != null ? Number(regionSsim.toFixed(4)) : null,
				mismatchPercent: Number((regionMismatch / (rw * rh) * 100).toFixed(2)),
				pass: regionSsim != null ? regionSsim >= regionThreshold : false
			});
		}
		regions.sort((a, b) => (a.ssim ?? 0) - (b.ssim ?? 0));
	}
}

const totalPixels = w * h;
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
	warnings
};

console.error(`SSIM: ${report.overallSsim} (threshold ${threshold}, ${report.pass ? 'PASS' : 'FAIL'})`);
console.error(`pixel mismatch: ${mismatchedPixels} / ${totalPixels} (${report.mismatchPercent}%)`);
if (diffPath) console.error(`diff overlay: ${diffPath}`);
if (regions.length) {
	const failed = regions.filter(r => !r.pass);
	console.error(`regions: ${regions.length} scored, ${failed.length} below threshold ${regionThreshold}`);
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
