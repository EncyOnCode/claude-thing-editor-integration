#!/usr/bin/env node
// Fetch Figma node tree via REST API. Run from user's machine (not sandbox).
//
// Usage:
//   FIGMA_TOKEN=figd_xxx node fetch-figma.mjs <fileKey> <nodeId> > snapshot.json
//
// Or with URL:
//   FIGMA_TOKEN=figd_xxx node fetch-figma.mjs --url 'https://www.figma.com/design/KEY/NAME?node-id=1663-54140' > snapshot.json
//
// Output: JSON with the requested node + flattened bbox map for matching.

const token = process.env.FIGMA_TOKEN;
if (!token) {
	console.error('error: FIGMA_TOKEN env var required');
	process.exit(1);
}

let fileKey, nodeId;
const args = process.argv.slice(2);
if (args[0] === '--url') {
	const url = args[1];
	const m = url.match(/figma\.com\/design\/([A-Za-z0-9]+)\/[^?]+\?.*node-id=([0-9]+-[0-9]+)/);
	if (!m) {
		console.error('error: cannot parse Figma URL');
		process.exit(1);
	}
	fileKey = m[1];
	nodeId = m[2].replace('-', ':');
} else {
	[fileKey, nodeId] = args;
}
if (!fileKey || !nodeId) {
	console.error('usage: fetch-figma.mjs <fileKey> <nodeId>   |   --url <figma-url>');
	process.exit(1);
}

const apiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`;
const res = await fetch(apiUrl, { headers: { 'X-FIGMA-TOKEN': token } });
if (!res.ok) {
	const body = await res.text();
	console.error(`error ${res.status}: ${body}`);
	process.exit(1);
}
const data = await res.json();

const root = data.nodes?.[nodeId]?.document;
if (!root) {
	console.error(`error: node ${nodeId} not found in response`);
	process.exit(1);
}

// Build flat map keyed by parent/name path.
const flat = {};
function walk(node, parentPath, parentBox) {
	const name = node.name || '';
	const path = parentPath ? `${parentPath}/${name}` : name;
	const bbox = node.absoluteBoundingBox || null;

	flat[path] = {
		id: node.id,
		name,
		type: node.type,
		visible: node.visible !== false,
		bbox,
		// scene-local coords (relative to root frame)
		localX: bbox && root.absoluteBoundingBox ? bbox.x - root.absoluteBoundingBox.x : null,
		localY: bbox && root.absoluteBoundingBox ? bbox.y - root.absoluteBoundingBox.y : null,
		width: bbox?.width ?? null,
		height: bbox?.height ?? null,
		rotation: node.rotation ?? 0,
		opacity: node.opacity ?? 1,
		fills: simplifyFills(node.fills),
		characters: node.characters ?? null,
		fontSize: node.style?.fontSize ?? null,
		fontFamily: node.style?.fontFamily ?? null,
		textAlignHorizontal: node.style?.textAlignHorizontal ?? null
	};

	(node.children || []).forEach(child => walk(child, path, bbox));
}

function simplifyFills(fills) {
	if (!fills || !fills.length) return null;
	return fills.map(f => {
		if (f.type === 'SOLID') {
			const c = f.color;
			const r = Math.round(c.r * 255);
			const g = Math.round(c.g * 255);
			const b = Math.round(c.b * 255);
			return { type: 'SOLID', tint: (r << 16) | (g << 8) | b, alpha: c.a ?? 1, opacity: f.opacity ?? 1, visible: f.visible !== false };
		}
		if (f.type === 'IMAGE') {
			return { type: 'IMAGE', imageRef: f.imageRef, scaleMode: f.scaleMode };
		}
		return { type: f.type };
	});
}

walk(root, '', null);
process.stdout.write(JSON.stringify({ fileKey, nodeId, root: { id: root.id, name: root.name, bbox: root.absoluteBoundingBox }, nodes: flat }, null, 2));
