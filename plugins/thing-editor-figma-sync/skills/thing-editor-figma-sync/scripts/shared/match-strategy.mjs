// Stacked Figma→scene matching strategies.
//
// Designers rarely follow Thing-Editor's hierarchical namePath naming, so
// exact-name match yields very poor coverage (often <2%). We layer four
// progressively-fuzzier strategies and one explicit fallback so diff-snapshot
// can audit *every* match's confidence.
//
// Strategy order (highest confidence first):
//   1. 'namePath'   exact name match               → high
//   2. 'pathSuffix' Figma path tail ⊆ scene namePath tail → medium
//   3. 'fuzzyLeaf'  Levenshtein distance ≤ 25%     → low
//   4. 'bbox'       world-space bbox overlap ≥ 80% → bbox
//   5. 'connectMap' explicit user mapping          → connectMap (wired in caller)
//
// Confidence ranking used by caller:
const CONFIDENCE_RANK = { high: 4, medium: 3, connectMap: 3, low: 2, bbox: 1 };

export function rankConfidence(c) { return CONFIDENCE_RANK[c] ?? 0; }

// Main entry point. Returns an array of match candidates sorted by confidence
// descending. Caller picks index 0 (highest).
//
//   sceneFlat:  namePath → entry (output of scene-walker)
//   figmaLayer: one entry from figma-walker's `layers` map
//   figmaSnap:  full walked-figma snapshot (for path lookups)
//   opts.designScale:   figma px → engine px (engineW / figmaRootW)
//   opts.engineMeta:    { gameSize, orientation }
//   opts.figmaRootFrame: figma layer with no parentPath (frame root)
export function findSceneMatches(sceneFlat, figmaLayer, figmaSnap, opts = {}) {
	const results = [];
	const seenKeys = new Set();

	function push(key, entry, matchedBy, confidence, extra) {
		if (seenKeys.has(key)) return;
		seenKeys.add(key);
		results.push({
			key,
			entry,
			matchedBy,
			confidence,
			namePath: entry.namePath,
			...extra
		});
	}

	// Strategy 1: exact name match (the historical default).
	const ident = figmaLayer.identifier;
	if (ident) {
		for (const [key, entry] of Object.entries(sceneFlat)) {
			if (entry.name === ident) push(key, entry, 'namePath', 'high');
		}
	}

	// Strategy 2: path-suffix match. Figma 'a/b/c/d' tail ⊆ scene 'x/y/c/d' tail.
	// Compare normalized segments (lowercase, underscores). Require at least
	// the leaf to match and one more parent segment, OR the leaf alone if it's
	// long enough to be distinctive (≥4 chars).
	const figPathSegs = splitSegs(figmaLayer.path || '', '/').map(normSeg);
	if (figPathSegs.length) {
		for (const [key, entry] of Object.entries(sceneFlat)) {
			if (seenKeys.has(key)) continue;
			const sceneSegs = splitSegs(entry.namePath || '', '/').map(normSeg);
			const overlap = trailingOverlap(figPathSegs, sceneSegs);
			const leaf = figPathSegs[figPathSegs.length - 1];
			if (overlap >= 2 || (overlap === 1 && leaf && leaf.length >= 4 && sceneSegs[sceneSegs.length - 1] === leaf)) {
				push(key, entry, 'pathSuffix', 'medium', { score: overlap });
			}
		}
	}

	// Strategy 3: fuzzy leaf match. Levenshtein distance / max(len) ≤ 0.25.
	// Compare normalized identifiers. Useful for "BG" vs "background",
	// "Cancel_1" vs "cancelLabel" type mismatches with similar substrings.
	if (ident) {
		const normIdent = normSeg(ident);
		for (const [key, entry] of Object.entries(sceneFlat)) {
			if (seenKeys.has(key)) continue;
			if (!entry.name) continue;
			const normName = normSeg(entry.name);
			if (!normName) continue;
			const maxLen = Math.max(normIdent.length, normName.length);
			if (maxLen < 3) continue;
			const dist = levenshtein(normIdent, normName);
			const ratio = dist / maxLen;
			if (ratio <= 0.25) {
				push(key, entry, 'fuzzyLeaf', 'low', { score: 1 - ratio });
			}
		}
	}

	// Strategy 4: bbox-proximity. Translate figma bbox → engine pixels via
	// designScale, find the scene entry whose world.bounds overlaps by ≥80%
	// AND has the closest area to the figma layer. Requires engineMeta +
	// figmaRootFrame. We pick "closest by area ratio" rather than first hit
	// because root containers (Scene/Main) overlap with everything — we want
	// the tightest enclosing scene node, not the topmost.
	const { designScale, engineMeta, figmaRootFrame } = opts;
	if (engineMeta && figmaRootFrame?.bbox && figmaLayer.bbox && designScale) {
		const fb = figmaLayer.bbox;
		const fx = (fb.x - figmaRootFrame.bbox.x) * designScale;
		const fy = (fb.y - figmaRootFrame.bbox.y) * designScale;
		const fw = fb.width * designScale;
		const fh = fb.height * designScale;
		const figBox = { x: fx, y: fy, width: fw, height: fh };
		const fArea = fw * fh;
		if (fw > 1 && fh > 1) {
			let bestBboxMatch = null;
			for (const [key, entry] of Object.entries(sceneFlat)) {
				if (seenKeys.has(key)) continue;
				const b = entry.world?.bounds;
				if (!b || b.width < 1 || b.height < 1) continue;
				const overlap = bboxOverlapRatio(figBox, b);
				if (overlap < 0.8) continue;
				const bArea = b.width * b.height;
				// Score blends overlap ratio with area-similarity. Identical-area
				// boxes that fully overlap score ~1; large enclosing boxes score
				// lower because their area ratio is small.
				const areaRatio = Math.min(fArea, bArea) / Math.max(fArea, bArea);
				const score = overlap * areaRatio;
				if (!bestBboxMatch || score > bestBboxMatch.score) {
					bestBboxMatch = { key, entry, score, overlap, areaRatio };
				}
			}
			// Only emit a bbox match when area-similarity is reasonable; below
			// 0.25 it means the scene node is >4× larger than the figma layer,
			// which is almost certainly a parent container rather than the
			// target entity. Skip rather than emit noise.
			if (bestBboxMatch && bestBboxMatch.areaRatio >= 0.25) {
				push(bestBboxMatch.key, bestBboxMatch.entry, 'bbox', 'bbox', { score: bestBboxMatch.score });
			}
		}
	}

	// Sort by confidence rank desc, then by score desc.
	results.sort((a, b) => {
		const r = rankConfidence(b.confidence) - rankConfidence(a.confidence);
		if (r !== 0) return r;
		return (b.score ?? 0) - (a.score ?? 0);
	});
	return results;
}

// --- helpers ---

function splitSegs(s, sep) {
	return s.split(sep).filter(Boolean);
}

function normSeg(s) {
	if (!s) return '';
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Count how many *trailing* segments match between two arrays.
function trailingOverlap(a, b) {
	let i = a.length - 1, j = b.length - 1, n = 0;
	while (i >= 0 && j >= 0 && a[i] === b[j] && a[i]) {
		n++; i--; j--;
	}
	return n;
}

// Iterative Levenshtein distance. O(m·n) memory in row-pair only.
export function levenshtein(a, b) {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = new Array(b.length + 1);
	let curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= b.length; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1] + 1,
				prev[j] + 1,
				prev[j - 1] + cost
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

// Overlap ratio: intersection-area / min(boxArea).
// Using min() rather than IoU because Figma frames often span larger areas
// than the engine entity inside them (e.g. an "Avatars" frame contains the
// avatar art but engine reports just the rendered Sprite bounds).
export function bboxOverlapRatio(a, b) {
	const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
	const inter = ix * iy;
	if (inter <= 0) return 0;
	const aArea = a.width * a.height;
	const bArea = b.width * b.height;
	const minArea = Math.min(aArea, bArea);
	return minArea > 0 ? inter / minArea : 0;
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	let fail = 0;
	function assert(name, cond) {
		if (cond) console.log(`PASS ${name}`);
		else { console.log(`FAIL ${name}`); fail++; }
	}

	// Levenshtein
	assert('lev equal', levenshtein('abc', 'abc') === 0);
	assert('lev insert', levenshtein('abc', 'abcd') === 1);
	assert('lev replace', levenshtein('abc', 'aXc') === 1);
	assert('lev empty', levenshtein('', 'abc') === 3);

	// bboxOverlapRatio
	assert('bbox full overlap',
		Math.abs(bboxOverlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }) - 1) < 1e-6);
	assert('bbox disjoint',
		bboxOverlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }) === 0);
	assert('bbox contained',
		Math.abs(bboxOverlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 2, y: 2, width: 4, height: 4 }) - 1) < 1e-6);

	// match strategies smoke
	const sceneFlat = {
		'main/screen/bet': { name: 'bet', namePath: 'main/screen/bet', world: { bounds: { x: 100, y: 100, width: 50, height: 20 } }, class: 'SizedContainer' },
		'main/screen/cancelButton/cancelLabel': { name: 'cancelLabel', namePath: 'main/screen/cancelButton/cancelLabel', world: { bounds: { x: 0, y: 0, width: 80, height: 30 } }, class: 'Text' }
	};
	const figmaSnap = { layers: {} };
	const figmaLayer = { identifier: 'bet', name: 'bet', path: 'frame/bet', bbox: { x: 100, y: 100, width: 50, height: 20 } };
	const r1 = findSceneMatches(sceneFlat, figmaLayer, figmaSnap);
	assert('exact match', r1.length >= 1 && r1[0].matchedBy === 'namePath');

	const fuzzyLayer = { identifier: 'cancellabe', name: 'cancellabe', path: 'unrelated/cancellabe' };
	const r2 = findSceneMatches(sceneFlat, fuzzyLayer, figmaSnap);
	assert('fuzzy match', r2.some(r => r.matchedBy === 'fuzzyLeaf'));

	const pathSuffixLayer = { identifier: 'cancelLabel', name: 'cancelLabel', path: 'frame/cancelButton/cancelLabel' };
	const r2b = findSceneMatches(sceneFlat, pathSuffixLayer, figmaSnap);
	assert('exact dominates path-suffix', r2b[0].matchedBy === 'namePath');

	const bboxLayer = { identifier: 'X_unrelated', name: 'X_unrelated', path: 'frame/X', bbox: { x: 100, y: 100, width: 50, height: 20 } };
	const r3 = findSceneMatches(sceneFlat, bboxLayer, figmaSnap, {
		designScale: 1,
		engineMeta: { gameSize: { W: 1920, H: 1080 } },
		figmaRootFrame: { bbox: { x: 0, y: 0, width: 1920, height: 1080 } }
	});
	assert('bbox match', r3.some(r => r.matchedBy === 'bbox'));

	process.exit(fail);
}
