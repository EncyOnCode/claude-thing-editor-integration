#!/usr/bin/env node
// Generate a figma.tokens.json skeleton from a fetched Figma variables file.
//
// Usage:
//   node scaffold-tokens.mjs --variables <fetched-tokens.json> [--out <path>] [--merge]
//
// Flags:
//   --variables <p>  required; raw OR flattened output of fetch-figma-vars.mjs.
//   --out <p>        target file (default ./figma.tokens.json).
//   --merge          if --out exists, preserve existing `engineToken` mappings.
//
// Output shape (Pattern A soft DS mapping):
//   {
//     "version": 1,
//     "colors": {
//       "primary-color": { "engineToken": null, "fallback": "0xff5500" }
//     },
//     "fontSizes": {
//       "h1-size": { "value": 32 }
//     },
//     "textStyles": {
//       "h1": { "fontSize": 32, "fontFamily": "GothamPro-Bold" }
//     }
//   }
//
// Each entry's `engineToken` starts as null — a human (or a future skill)
// must wire it to the actual GameThemes path. With --merge, existing
// mappings are preserved across re-runs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFigmaVariables } from './shared/figma-tokens.mjs';

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
}
function flagPresent(name) { return args.includes(name); }

const varsPath = flagValue('--variables');
const outPath = flagValue('--out') || resolve(process.cwd(), 'figma.tokens.json');
const merge = flagPresent('--merge');

if (!varsPath) {
	console.error('usage: scaffold-tokens.mjs --variables <fetched-tokens.json> [--out <path>] [--merge]');
	process.exit(1);
}

const variables = loadFigmaVariables(varsPath);

// Load raw to also discover text styles (loadFigmaVariables surfaces styles
// via the flattened path; raw shape preserves styleDetails separately).
const rawJson = JSON.parse(readFileSync(resolve(varsPath), 'utf8'));
const textStyles = rawJson.styles && typeof rawJson.styles === 'object' && !Array.isArray(rawJson.styles)
	? rawJson.styles
	: rawJson.styleDetails || {};

const FONT_SIZE_NAME_RE = /(size|fontSize|font-size|FontSize)/i;

const colors = {};
const fontSizes = {};
const textStylesOut = {};

for (const v of Object.values(variables.byId || {})) {
	if (v.type === 'COLOR') {
		colors[v.name] = {
			engineToken: null,
			fallback: v.defaultHex != null ? `0x${v.defaultHex.toString(16).padStart(6, '0')}` : null
		};
	} else if (v.type === 'FLOAT' && FONT_SIZE_NAME_RE.test(v.name)) {
		// Pick default-mode numeric value.
		const defaultModeVal = v.valuesByMode?.[v.defaultModeId]?.value
			?? Object.values(v.valuesByMode || {})[0]?.value
			?? null;
		fontSizes[v.name] = { value: typeof defaultModeVal === 'number' ? defaultModeVal : null };
	}
}

for (const style of Object.values(textStyles || {})) {
	if (!style?.name) continue;
	if (style.styleType && style.styleType !== 'TEXT') continue;
	textStylesOut[style.name] = {
		fontSize: style.fontSize ?? null,
		fontFamily: style.fontFamily ?? null,
		fontWeight: style.fontWeight ?? null,
		lineHeightPx: style.lineHeightPx ?? null
	};
}

// Merge with existing file if requested.
let preserved = 0;
let existing = null;
if (merge && existsSync(resolve(outPath))) {
	try {
		existing = JSON.parse(readFileSync(resolve(outPath), 'utf8'));
	} catch (e) {
		console.error(`warn: failed to parse existing --out file (${e.message}); ignoring --merge`);
	}
}

function mergeSection(skeleton, existingMap) {
	if (!existingMap) return skeleton;
	for (const [name, fresh] of Object.entries(skeleton)) {
		const prev = existingMap[name];
		if (prev && prev.engineToken != null) {
			skeleton[name] = { ...fresh, engineToken: prev.engineToken };
			preserved++;
		}
	}
	// Also keep any entries that exist locally but no longer in Figma (don't drop user-added rows).
	for (const [name, prev] of Object.entries(existingMap)) {
		if (!skeleton[name]) skeleton[name] = prev;
	}
	return skeleton;
}

if (existing) {
	mergeSection(colors, existing.colors);
	mergeSection(fontSizes, existing.fontSizes);
	mergeSection(textStylesOut, existing.textStyles);
}

const output = {
	version: 1,
	generatedAt: new Date().toISOString(),
	source: { fileKey: rawJson.fileKey || null, variablesPath: resolve(varsPath) },
	colors,
	fontSizes,
	textStyles: textStylesOut
};

writeFileSync(resolve(outPath), JSON.stringify(output, null, 2));
console.error(`wrote ${resolve(outPath)}`);
console.error(`${Object.keys(colors).length} color variables, ${Object.keys(fontSizes).length} font sizes, ${Object.keys(textStylesOut).length} text styles, ${preserved} already-mapped preserved`);
