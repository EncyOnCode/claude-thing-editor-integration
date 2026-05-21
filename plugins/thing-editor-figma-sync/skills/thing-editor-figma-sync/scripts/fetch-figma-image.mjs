#!/usr/bin/env node
// Fetch a Figma node as a PNG via the Images REST endpoint. Run from the
// user's machine (not a sandbox).
//
// Usage:
//   FIGMA_TOKEN=figd_xxx node fetch-figma-image.mjs <fileKey> <nodeId> --out frame.png [--scale 1] [--format png|jpg|svg]
//   FIGMA_TOKEN=figd_xxx node fetch-figma-image.mjs --url '<figma-url>' --out frame.png [--scale 1]
//
// Endpoint: GET /v1/images/:fileKey?ids=<id>&format=png returns a JSON
// response { images: { "<nodeId>": "<presigned-s3-url>" } }; we then GET
// the S3 URL and write the body to --out.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}

const token = process.env.FIGMA_TOKEN;
if (!token) {
	console.error('error: FIGMA_TOKEN env var required');
	process.exit(1);
}

const outPath = flagValue('--out');
const scale = flagValue('--scale') || '1';
const format = flagValue('--format') || 'png';

if (!outPath) {
	console.error('error: --out required');
	console.error('usage: fetch-figma-image.mjs <fileKey> <nodeId> --out frame.png [--scale 1] [--format png|jpg|svg]');
	console.error('       fetch-figma-image.mjs --url <figma-url> --out frame.png');
	process.exit(1);
}

let fileKey;
let nodeId;
if (args[0] === '--url') {
	const url = args[1];
	const m = url?.match(/figma\.com\/design\/([A-Za-z0-9]+)\/[^?]+\?.*node-id=([0-9]+-[0-9]+)/);
	if (!m) {
		console.error('error: cannot parse Figma URL');
		process.exit(1);
	}
	fileKey = m[1];
	nodeId = m[2].replace('-', ':');
} else {
	const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--scale' && args[i - 1] !== '--format');
	[fileKey, nodeId] = positional;
}

if (!fileKey || !nodeId) {
	console.error('error: fileKey and nodeId required');
	process.exit(1);
}

const apiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=${format}&scale=${scale}`;
const res = await fetch(apiUrl, { headers: { 'X-FIGMA-TOKEN': token } });
if (!res.ok) {
	console.error(`error ${res.status}: ${await res.text()}`);
	process.exit(1);
}
const data = await res.json();
if (data.err) {
	console.error(`figma error: ${data.err}`);
	process.exit(1);
}
const imageUrl = data.images?.[nodeId];
if (!imageUrl) {
	console.error(`error: no image URL returned for node ${nodeId}; response keys: ${Object.keys(data.images || {}).join(', ')}`);
	process.exit(1);
}

const imgRes = await fetch(imageUrl);
if (!imgRes.ok) {
	console.error(`error downloading image: ${imgRes.status}`);
	process.exit(1);
}
const buffer = Buffer.from(await imgRes.arrayBuffer());
writeFileSync(resolve(outPath), buffer);
console.error(`wrote ${buffer.length} bytes to ${outPath} (scale=${scale}, format=${format})`);
