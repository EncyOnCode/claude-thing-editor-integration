// Shared coordinate-resolution math: Figma absoluteBoundingBox → Thing-Editor scene coords.
// Codifies rules from references/coord-mapping.md.
//
// Exports:
//   figmaToScene(figmaNode, parentOrigin, classToken, options) → { x, y, scaleX, scaleY, rotation, alpha, tint, width, height }
//   resolveAnchor(classToken, meta) → { x, y } | null
//   degToRad(deg)
//   rgbaToTint(r, g, b) → 24-bit hex int
//   computeScale(figmaWidth, figmaHeight, textureBaseWidth, textureBaseHeight)

import { CLASS_TOKENS } from './class-tokens.mjs';

export function degToRad(deg) {
	if (deg == null || deg === 0) return 0;
	return (deg * Math.PI) / 180;
}

// Convert 0-1 RGB triplet (Figma format) to Pixi 24-bit hex int.
export function rgbaToTint(r, g, b) {
	const ri = Math.round((r ?? 0) * 255) & 0xff;
	const gi = Math.round((g ?? 0) * 255) & 0xff;
	const bi = Math.round((b ?? 0) * 255) & 0xff;
	return (ri << 16) | (gi << 8) | bi;
}

// Compute scale factors for Sprite based on Figma dimensions vs texture base size.
// Returns { scaleX, scaleY } or null if texture base is unknown.
export function computeScale(figmaWidth, figmaHeight, textureBaseWidth, textureBaseHeight) {
	if (!textureBaseWidth || !textureBaseHeight) return null;
	return {
		scaleX: figmaWidth / textureBaseWidth,
		scaleY: figmaHeight / textureBaseHeight
	};
}

// Resolve anchor for a class. Uses meta override if present, else class default.
export function resolveAnchor(classToken, meta = {}) {
	const spec = CLASS_TOKENS[classToken];
	if (!spec || !spec.anchor) return null;
	// Allow meta override: (anchor:0.5,0.5)
	if (Array.isArray(meta.anchor)) {
		return { x: meta.anchor[0], y: meta.anchor[1] };
	}
	return { ...spec.anchor };
}

// Convert Figma anchor-aware coordinates.
// parentOrigin = { x, y } — the world position of the parent's origin.
//                For Figma root frame, parentOrigin = { x: rootFrame.x, y: rootFrame.y }.
//                For nested levels, parent's absoluteBoundingBox.x/y.
//
// figmaNode = { absoluteBoundingBox: { x, y, width, height }, rotation?, opacity?, fills? }
//
// classToken = canonical token (Sprite, DSprite, Text, Container, ...).
//
// options:
//   textureBase: { width, height } — for Sprite scale computation
//   skipScale: bool — skip scale if class is Text/Text-ancestor
//
// Returns an emit-ready object with only the fields that apply.
export function figmaToScene(figmaNode, parentOrigin, classToken, options = {}) {
	const bbox = figmaNode.absoluteBoundingBox || {
		x: figmaNode.x ?? 0,
		y: figmaNode.y ?? 0,
		width: figmaNode.width ?? 0,
		height: figmaNode.height ?? 0
	};

	const px = parentOrigin?.x ?? 0;
	const py = parentOrigin?.y ?? 0;

	const meta = options.meta || {};
	const anchor = resolveAnchor(classToken, meta);

	// Compute scene-local coordinates with anchor adjustment.
	let x, y;
	if (anchor) {
		x = bbox.x - px + bbox.width * anchor.x;
		y = bbox.y - py + bbox.height * anchor.y;
	} else {
		x = bbox.x - px;
		y = bbox.y - py;
	}

	const result = { x, y };

	// Width/height for sized classes.
	const sizedClasses = new Set(['SizedContainer', 'NineSlicePlane', 'Shape', 'ShapeButton', 'Container']);
	if (sizedClasses.has(classToken)) {
		result.width = bbox.width;
		result.height = bbox.height;
	}

	// Scale for Sprite-class with texture base info.
	if (!options.skipScale && (classToken === 'Sprite' || classToken === 'DSprite')) {
		const scale = computeScale(bbox.width, bbox.height, options.textureBase?.width, options.textureBase?.height);
		if (scale) {
			result.scaleX = scale.scaleX;
			result.scaleY = scale.scaleY;
		} else if (options.textureBase === undefined) {
			result.__textureBaseUnknown = true; // sidecar TODO
		}
	}

	// Rotation
	if (figmaNode.rotation != null && figmaNode.rotation !== 0) {
		result.rotation = degToRad(figmaNode.rotation);
	}

	// Opacity / alpha
	if (figmaNode.opacity != null && figmaNode.opacity !== 1) {
		result.alpha = figmaNode.opacity;
	}

	// Tint from first SOLID fill
	const tint = extractTint(figmaNode.fills);
	if (tint != null && tint !== 0xffffff) {
		result.tint = tint;
	}

	return result;
}

// Extract tint from Figma fills array. Returns 24-bit hex int or null.
export function extractTint(fills) {
	if (!Array.isArray(fills)) return null;
	const solid = fills.find(f => f && f.type === 'SOLID' && f.visible !== false);
	if (!solid || !solid.color) return null;
	const c = solid.color;
	return rgbaToTint(c.r, c.g, c.b);
}

// Round to N decimal places. Used to clean up float noise.
export function round(n, places = 2) {
	const mul = Math.pow(10, places);
	return Math.round(n * mul) / mul;
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	let fail = 0;

	// degToRad
	const r90 = degToRad(90);
	if (Math.abs(r90 - Math.PI / 2) > 1e-10) { console.log(`FAIL degToRad(90)=${r90}`); fail++; } else console.log(`PASS degToRad(90)`);

	// rgbaToTint
	const t = rgbaToTint(1, 0, 0);
	if (t !== 0xff0000) { console.log(`FAIL rgbaToTint(red)=${t.toString(16)}`); fail++; } else console.log(`PASS rgbaToTint(red)`);

	// figmaToScene — Sprite (anchor 0,0)
	const spr = figmaToScene(
		{ absoluteBoundingBox: { x: 100, y: 200, width: 50, height: 50 } },
		{ x: 0, y: 0 },
		'Sprite'
	);
	if (spr.x !== 100 || spr.y !== 200) { console.log(`FAIL Sprite ${JSON.stringify(spr)}`); fail++; } else console.log(`PASS Sprite anchor 0,0`);

	// figmaToScene — DSprite (anchor 0.5,0.5)
	const dspr = figmaToScene(
		{ absoluteBoundingBox: { x: 100, y: 200, width: 50, height: 50 } },
		{ x: 0, y: 0 },
		'DSprite'
	);
	if (dspr.x !== 125 || dspr.y !== 225) { console.log(`FAIL DSprite ${JSON.stringify(dspr)}`); fail++; } else console.log(`PASS DSprite anchor 0.5,0.5`);

	// figmaToScene — relative to parent origin
	const child = figmaToScene(
		{ absoluteBoundingBox: { x: 1100, y: 1200, width: 50, height: 50 } },
		{ x: 1000, y: 1000 },
		'Sprite'
	);
	if (child.x !== 100 || child.y !== 200) { console.log(`FAIL child-parent ${JSON.stringify(child)}`); fail++; } else console.log(`PASS child relative to parent`);

	// Scale
	const sized = computeScale(100, 50, 200, 100);
	if (sized.scaleX !== 0.5 || sized.scaleY !== 0.5) { console.log(`FAIL scale ${JSON.stringify(sized)}`); fail++; } else console.log(`PASS scale 0.5`);

	// Rotation only emitted when non-zero
	const rotNode = figmaToScene(
		{ absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, rotation: 45 },
		{ x: 0, y: 0 },
		'Sprite'
	);
	if (Math.abs(rotNode.rotation - Math.PI / 4) > 1e-10) { console.log(`FAIL rotation`); fail++; } else console.log(`PASS rotation 45deg → π/4`);

	// Tint extraction
	const tintNode = figmaToScene(
		{ absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }] },
		{ x: 0, y: 0 },
		'Sprite'
	);
	if (tintNode.tint !== 0x00ff00) { console.log(`FAIL tint ${tintNode.tint?.toString(16)}`); fail++; } else console.log(`PASS tint green`);

	process.exit(fail);
}
