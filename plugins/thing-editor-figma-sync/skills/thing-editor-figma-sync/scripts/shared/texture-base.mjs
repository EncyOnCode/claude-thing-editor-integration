// Texture base-size lookup for Sprite scale computation.
// Order of resolution:
//   1. Atlas frames in .tmp/assets-{preloader,main,delayed}.json (if --project given)
//   2. Spritesheet JSON in assets/img/ (search for "frames" with matching name)
//   3. PNG header read of assets/img/<name>.png (read first 24 bytes)
//
// Exports:
//   resolveTextureBase(assetName, projectRoot) → { width, height } | null
//   resolvePngDimensions(pngPath) → { width, height } | null

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';

const ATLAS_FILES = ['assets-preloader.json', 'assets-main.json', 'assets-delayed.json'];
const TMP_PATHS = ['.tmp', 'tmp'];
const IMG_PATHS = ['assets/img', 'assets/images'];

export function resolveTextureBase(assetName, projectRoot) {
	if (!projectRoot) return null;
	const root = resolve(projectRoot);

	// 1. Atlas frames in .tmp/
	for (const tmpDir of TMP_PATHS) {
		for (const atlasFile of ATLAS_FILES) {
			const atlasPath = join(root, tmpDir, atlasFile);
			if (!existsSync(atlasPath)) continue;
			try {
				const data = JSON.parse(readFileSync(atlasPath, 'utf8'));
				const frame = findInAtlasData(data, assetName);
				if (frame) return frame;
			} catch (e) { /* skip malformed */ }
		}
	}

	// 2. Spritesheet JSONs in assets/img/ (recursive)
	for (const imgDir of IMG_PATHS) {
		const imgRoot = join(root, imgDir);
		if (!existsSync(imgRoot)) continue;
		const found = searchSpritesheets(imgRoot, assetName);
		if (found) return found;
	}

	// 3. PNG header read
	for (const imgDir of IMG_PATHS) {
		const candidates = [
			join(root, imgDir, assetName),
			join(root, imgDir, assetName + '.png'),
			join(root, imgDir, basename(assetName) + '.png')
		];
		for (const c of candidates) {
			if (existsSync(c) && statSync(c).isFile()) {
				const dims = resolvePngDimensions(c);
				if (dims) return dims;
			}
		}
	}

	return null;
}

function findInAtlasData(data, assetName) {
	// Atlas data is an array of asset descriptors OR an object with images[] etc.
	// Try a few shapes.
	if (!data) return null;
	const candidates = [];
	if (Array.isArray(data)) candidates.push(...data);
	if (data.images) candidates.push(...data.images);
	if (data.frames) {
		// Spritesheet-style: { frames: { "name.png": { frame: {x,y,w,h}, sourceSize: {w,h} } } }
		const f = data.frames[assetName] || data.frames[assetName + '.png'];
		if (f) {
			const s = f.sourceSize || f.frame;
			if (s) return { width: s.w, height: s.h };
		}
	}
	for (const c of candidates) {
		if (!c || typeof c !== 'object') continue;
		if ((c.name === assetName || c.assetName === assetName) && c.width && c.height) {
			return { width: c.width, height: c.height };
		}
	}
	return null;
}

function searchSpritesheets(dir, assetName, depth = 0) {
	if (depth > 5) return null;
	let entries;
	try { entries = readdirSync(dir); } catch { return null; }
	for (const e of entries) {
		const full = join(dir, e);
		let st;
		try { st = statSync(full); } catch { continue; }
		if (st.isDirectory()) {
			const r = searchSpritesheets(full, assetName, depth + 1);
			if (r) return r;
		} else if (extname(e) === '.json') {
			try {
				const data = JSON.parse(readFileSync(full, 'utf8'));
				const r = findInAtlasData(data, assetName);
				if (r) return r;
			} catch { /* skip */ }
		}
	}
	return null;
}

// Read a PNG file header and extract width/height from IHDR chunk.
// PNG signature: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
// Then IHDR chunk: 4 bytes length, 4 bytes type "IHDR", 4 bytes width, 4 bytes height, ...
export function resolvePngDimensions(pngPath) {
	try {
		const buf = readFileSync(pngPath, { length: 24 });
		if (buf.length < 24) return null;
		// Check PNG signature
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for (let i = 0; i < 8; i++) {
			if (buf[i] !== sig[i]) return null;
		}
		// IHDR starts at byte 16 (header is 8 bytes, then 4 bytes length, 4 bytes type)
		const width = buf.readUInt32BE(16);
		const height = buf.readUInt32BE(20);
		return { width, height };
	} catch { return null; }
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const { writeFileSync, mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');

	let fail = 0;

	// Create a fake PNG (signature + IHDR with width=512, height=256)
	const dir = mkdtempSync(join(tmpdir(), 'tex-base-test-'));
	const imgDir = join(dir, 'assets/img');
	mkdirSync(imgDir, { recursive: true });
	const pngPath = join(imgDir, 'test.png');
	const buf = Buffer.alloc(24);
	// signature
	[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => buf[i] = b);
	// IHDR length (13) + type ("IHDR")
	buf.writeUInt32BE(13, 8);
	buf.write('IHDR', 12);
	// width=512, height=256
	buf.writeUInt32BE(512, 16);
	buf.writeUInt32BE(256, 20);
	writeFileSync(pngPath, buf);

	const dims = resolvePngDimensions(pngPath);
	if (!dims || dims.width !== 512 || dims.height !== 256) {
		console.log(`FAIL resolvePngDimensions: ${JSON.stringify(dims)}`); fail++;
	} else console.log(`PASS resolvePngDimensions(${pngPath}) = 512x256`);

	const base = resolveTextureBase('test', dir);
	if (!base || base.width !== 512 || base.height !== 256) {
		console.log(`FAIL resolveTextureBase: ${JSON.stringify(base)}`); fail++;
	} else console.log(`PASS resolveTextureBase("test") via PNG header`);

	// Negative test: file doesn't exist
	const missing = resolveTextureBase('nonexistent', dir);
	if (missing !== null) {
		console.log(`FAIL nonexistent should return null: ${JSON.stringify(missing)}`); fail++;
	} else console.log(`PASS resolveTextureBase("nonexistent") = null`);

	rmSync(dir, { recursive: true });
	process.exit(fail);
}
