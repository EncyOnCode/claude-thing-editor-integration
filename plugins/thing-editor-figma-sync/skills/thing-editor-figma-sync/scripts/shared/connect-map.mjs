// Read/write figma.connect.json with v1→v2 migration.
// Schema documented in references/patch-schema.md.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Returns:
// {
//   version: 2,
//   figmaFileKey?: string,
//   mappings: [
//     { figmaNodeId?, figmaComponentSetId?, scenePath?, prefabName?, classOverride?, variantMap?, assetMappings?, skip?, notes? }
//   ]
// }
export function readConnectMap(path) {
	const abs = resolve(path);
	if (!existsSync(abs)) {
		return { version: 2, mappings: [], _new: true };
	}
	const raw = readFileSync(abs, 'utf8');
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`figma.connect.json is malformed JSON at ${abs}: ${e.message}`);
	}

	// v1 detection: missing `version` field AND looks like a flat mapping array OR a single bare object.
	if (Array.isArray(parsed)) {
		// v1: bare array of { figmaNodeId, scenePath }
		return {
			version: 2,
			mappings: parsed.map(migrateV1Entry),
			_migrated: true
		};
	}
	if (parsed.version == null && (parsed.figmaNodeId || parsed.scenePath)) {
		// v1: single bare object
		return {
			version: 2,
			mappings: [migrateV1Entry(parsed)],
			_migrated: true
		};
	}
	if (parsed.version == null) {
		// Unrecognized; treat as empty
		return { version: 2, mappings: parsed.mappings || [], _migrated: true };
	}
	if (parsed.version !== 2) {
		throw new Error(`Unsupported figma.connect.json version ${parsed.version}; only v2 supported.`);
	}
	return parsed;
}

function migrateV1Entry(e) {
	return {
		figmaNodeId: e.figmaNodeId,
		scenePath: e.scenePath,
		notes: e.notes || (e._note ? e._note : undefined)
	};
}

// Find mapping for a given Figma node (by id or componentSetId).
// Returns the matching entry or null.
export function findMapping(connectMap, figmaNode) {
	if (!connectMap || !connectMap.mappings) return null;
	const id = figmaNode.id || figmaNode.figmaNodeId;
	const componentSetId = figmaNode.componentSetId;
	for (const m of connectMap.mappings) {
		if (m.figmaNodeId && id && m.figmaNodeId === id) return m;
		if (m.figmaComponentSetId && componentSetId && m.figmaComponentSetId === componentSetId) return m;
	}
	return null;
}

// Resolve variant from a mapping + instance variant properties.
// variantProps is an object like { State: 'default', Size: 'large' }.
// Returns prefab name from variantMap or default prefabName.
export function resolveVariant(mapping, variantProps) {
	if (!mapping) return null;
	if (mapping.variantMap && variantProps) {
		// Build lookup key from props: "State=default,Size=large"
		const key = Object.entries(variantProps)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${v}`)
			.join(',');
		if (mapping.variantMap[key]) return mapping.variantMap[key];
		// Try single-prop matches
		for (const [k, v] of Object.entries(variantProps)) {
			const singleKey = `${k}=${v}`;
			if (mapping.variantMap[singleKey]) return mapping.variantMap[singleKey];
		}
	}
	return mapping.prefabName || null;
}

// Write back, preserving formatting where possible.
export function writeConnectMap(path, connectMap) {
	const abs = resolve(path);
	const clean = {
		version: 2,
		...(connectMap.figmaFileKey ? { figmaFileKey: connectMap.figmaFileKey } : {}),
		mappings: connectMap.mappings || []
	};
	const indent = existsSync(abs)
		? (readFileSync(abs, 'utf8').includes('\n\t') ? '\t' : '  ')
		: '\t';
	writeFileSync(abs, JSON.stringify(clean, null, indent) + '\n');
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');

	const dir = mkdtempSync(join(tmpdir(), 'connect-map-test-'));
	let fail = 0;

	// v1 array
	const v1Path = join(dir, 'v1.json');
	writeFileSync(v1Path, JSON.stringify([{ figmaNodeId: '1:23', scenePath: [':', 0] }]));
	const v1Read = readConnectMap(v1Path);
	if (v1Read.version !== 2 || !v1Read._migrated || v1Read.mappings.length !== 1) {
		console.log(`FAIL v1 array migration: ${JSON.stringify(v1Read)}`); fail++;
	} else console.log(`PASS v1 array → v2 migrated`);

	// v2 read
	const v2Path = join(dir, 'v2.json');
	writeFileSync(v2Path, JSON.stringify({
		version: 2,
		figmaFileKey: 'abc',
		mappings: [
			{ figmaComponentSetId: '5:67', prefabName: 'cardItem', variantMap: { 'State=default': 'cardItem', 'State=hover': 'cardItemHover' } }
		]
	}));
	const v2Read = readConnectMap(v2Path);
	if (v2Read.version !== 2 || v2Read.mappings.length !== 1) {
		console.log(`FAIL v2 read`); fail++;
	} else console.log(`PASS v2 read`);

	// findMapping by componentSetId
	const found = findMapping(v2Read, { componentSetId: '5:67' });
	if (!found || found.prefabName !== 'cardItem') {
		console.log(`FAIL findMapping`); fail++;
	} else console.log(`PASS findMapping by componentSetId`);

	// resolveVariant
	const v = resolveVariant(found, { State: 'hover' });
	if (v !== 'cardItemHover') {
		console.log(`FAIL resolveVariant: ${v}`); fail++;
	} else console.log(`PASS resolveVariant`);

	// Write + re-read
	const outPath = join(dir, 'out.json');
	writeConnectMap(outPath, v2Read);
	const reread = readConnectMap(outPath);
	if (reread.mappings.length !== 1 || reread.mappings[0].prefabName !== 'cardItem') {
		console.log(`FAIL round-trip`); fail++;
	} else console.log(`PASS write + re-read round-trip`);

	rmSync(dir, { recursive: true });
	process.exit(fail);
}
