#!/usr/bin/env node
// Fetch Figma variables (Design System color tokens / float tokens / etc).
//
// Endpoint: GET /v1/files/:file_key/variables/local — returns
//   { meta: { variableCollections, variables }, ... }
//
// Usage:
//   FIGMA_TOKEN=figd_xxx node fetch-figma-vars.mjs <fileKey> > tokens.json
//   FIGMA_TOKEN=figd_xxx node fetch-figma-vars.mjs --url '<figma-url>' > tokens.json
//   FIGMA_TOKEN=figd_xxx node fetch-figma-vars.mjs <fileKey> --flatten > tokens.json
//   FIGMA_TOKEN=figd_xxx node fetch-figma-vars.mjs <fileKey> --include-styles > tokens.json
//
// Flags:
//   --flatten          emit normalized lightweight shape (see below) instead of raw response.
//   --include-styles   also fetch /v1/files/:fileKey/styles and merge text styles.
//   --url <url>        derive fileKey from a Figma URL instead of positional arg.
//
// Flattened output shape:
//   {
//     version: 1, fetchedAt, fileKey,
//     collections: [{ id, name, modes, defaultModeId }],
//     variables: [
//       { id, name, type, collectionId, defaultModeId, defaultHex?, values: [{ modeId, modeName, value }] }
//     ],
//     styles: { [styleId]: { id, name, styleType, ...textStyle? } }     // only with --include-styles
//   }
//
// Pattern A (soft) DS support: the resulting JSON is consumed by
// scaffold-tokens.mjs (to bootstrap figma.tokens.json) and by
// shared/figma-tokens.mjs (for the diff-snapshot token-hint warnings).
// Engine resolution of token references is out of scope here.

import { normalizeVariables, colorValueToHex } from './shared/figma-tokens.mjs';

const token = process.env.FIGMA_TOKEN;
if (!token) {
	console.error('error: FIGMA_TOKEN env var required');
	process.exit(1);
}

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const flatten = flagPresent('--flatten');
const includeStyles = flagPresent('--include-styles');

let fileKey;
if (args[0] === '--url') {
	const url = args[1];
	const m = url?.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/);
	if (!m) {
		console.error('error: cannot parse Figma URL');
		process.exit(1);
	}
	fileKey = m[1];
} else {
	fileKey = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url');
}

if (!fileKey) {
	console.error('usage: fetch-figma-vars.mjs <fileKey> [--flatten] [--include-styles]');
	console.error('       fetch-figma-vars.mjs --url <figma-url> [--flatten] [--include-styles]');
	process.exit(1);
}

const headers = { 'X-FIGMA-TOKEN': token };

const varsUrl = `https://api.figma.com/v1/files/${fileKey}/variables/local`;
const varsRes = await fetch(varsUrl, { headers });
if (!varsRes.ok) {
	const body = await varsRes.text();
	console.error(`error ${varsRes.status} fetching variables: ${body}`);
	process.exit(1);
}
const varsData = await varsRes.json();

let stylesPayload = null;
let styleDetails = {};
if (includeStyles) {
	const stylesUrl = `https://api.figma.com/v1/files/${fileKey}/styles`;
	const stylesRes = await fetch(stylesUrl, { headers });
	if (!stylesRes.ok) {
		console.error(`warn: ${stylesRes.status} fetching styles: ${await stylesRes.text()}`);
	} else {
		stylesPayload = await stylesRes.json();
		// stylesPayload.meta.styles is an array of { key, file_key, node_id, style_type, name, ... }
		// To get full style definitions (fontSize/fontFamily etc.) we need the
		// node lookup. Issue one batched /v1/files/:key/nodes request.
		const textStyleNodeIds = (stylesPayload?.meta?.styles || [])
			.filter(s => s.style_type === 'TEXT')
			.map(s => s.node_id)
			.filter(Boolean);
		if (textStyleNodeIds.length) {
			const idsParam = textStyleNodeIds.map(encodeURIComponent).join(',');
			const nodesUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${idsParam}`;
			const nodesRes = await fetch(nodesUrl, { headers });
			if (nodesRes.ok) {
				const nodesData = await nodesRes.json();
				for (const [nodeId, wrapper] of Object.entries(nodesData.nodes || {})) {
					const doc = wrapper?.document;
					if (!doc) continue;
					styleDetails[nodeId] = {
						id: nodeId,
						name: doc.name,
						styleType: 'TEXT',
						fontSize: doc.style?.fontSize ?? null,
						fontFamily: doc.style?.fontFamily ?? null,
						fontWeight: doc.style?.fontWeight ?? null,
						lineHeightPx: doc.style?.lineHeightPx ?? null,
						letterSpacing: doc.style?.letterSpacing ?? null,
						textAlignHorizontal: doc.style?.textAlignHorizontal ?? null,
						textAlignVertical: doc.style?.textAlignVertical ?? null
					};
				}
			} else {
				console.error(`warn: ${nodesRes.status} fetching style nodes: ${await nodesRes.text()}`);
			}
		}
	}
}

if (!flatten) {
	const out = {
		fetchedAt: new Date().toISOString(),
		fileKey,
		variables: varsData,
		styles: stylesPayload || undefined,
		styleDetails: includeStyles ? styleDetails : undefined
	};
	process.stdout.write(JSON.stringify(out, null, 2));
	process.exit(0);
}

// --flatten path
const normalized = normalizeVariables(varsData);

const collections = normalized.collections.map(c => ({
	id: c.id,
	name: c.name,
	modes: c.modes,
	defaultModeId: c.defaultModeId
}));

const variables = Object.values(normalized.byId).map(v => {
	const values = Object.entries(v.valuesByMode).map(([modeId, mv]) => ({
		modeId,
		modeName: mv.modeName,
		value: v.type === 'COLOR' ? colorValueToHex(mv.value) ?? mv.value : mv.value
	}));
	return {
		id: v.id,
		name: v.name,
		type: v.type,
		collectionId: v.collectionId,
		collectionName: v.collectionName,
		defaultModeId: v.defaultModeId,
		defaultHex: v.type === 'COLOR' ? v.defaultHex ?? null : undefined,
		values
	};
});

const out = {
	version: 1,
	fetchedAt: new Date().toISOString(),
	fileKey,
	collections,
	variables,
	styles: includeStyles ? styleDetails : undefined
};

process.stdout.write(JSON.stringify(out, null, 2));
console.error(`fetched ${variables.length} variables, ${collections.length} collections${includeStyles ? `, ${Object.keys(styleDetails).length} text styles` : ''}`);
