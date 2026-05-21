#!/usr/bin/env node
// Build a class registry for a Thing-Editor project by scanning .c.ts source.
// Phase 1: extends-chain resolution only. Editables are Phase 2.
//
// Usage (CLI):
//   node project-class-registry.mjs <project-root> [--rebuild] [--json|--summary]
//
// API:
//   import { loadRegistry } from './project-class-registry.mjs';
//   const reg = loadRegistry('/path/to/project', { rebuild: false });
//   reg.classes['CardItem'] = { file, extends, chain, anchor, isText, isLayoutManaged, hooks, source }
//
// Resolution rules:
//   - Project scan: <project>/assets/src/**/*.c.ts
//   - Libs: from thing-project.json `libs[]`, resolved at <monorepo>/libs/<lib>/assets/src/**/*.c.ts
//   - Engine: <monorepo>/thing-editor/src/engine/lib/assets/src/**/*.c.ts
//   - Monorepo root: walk up from project until dir contains `thing-editor/` and `libs/`.
//   - Import resolution: 'thing-editor/...' → <monorepo>/thing-editor/...; './x.c' → relative; 'pixi.js' → PIXI terminator.
//   - On name conflict: project > lib > engine. Earlier scan root wins; conflicts recorded.
//   - On prototype-extended file (no `export default class`): treated as terminator with file's expected class name.

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';

const PIXI_ROOTS = new Set([
	'Container', 'Sprite', 'Text', 'BitmapText', 'HTMLText', 'Graphics',
	'ParticleContainer', 'NineSlicePlane', 'TilingSprite', 'Mesh', 'AnimatedSprite',
	'DisplayObject'
]);

// Mirrors thing-editor-figma-sync/shared/class-tokens.mjs. Duplicated to avoid
// import cycle; keep in sync. Values are nullable to signal "no override".
const BUILTIN_ANCHORS = {
	Sprite: { x: 0, y: 0 },
	DSprite: { x: 0.5, y: 0.5 },
	Text: { x: 0, y: 0 },
	BitmapText: { x: 0, y: 0 },
	HTMLText: { x: 0, y: 0 },
	Button: { x: 0.5, y: 0.5 },
	MovieClip: { x: 0.5, y: 0.5 },
	NineSlicePlane: { x: 0, y: 0 }
};

const TEXT_CLASSES = new Set(['Text', 'BitmapText', 'HTMLText', 'Label', 'MultilineText', 'TextRep']);
const LAYOUT_CLASSES = new Set(['LayoutGroup', 'LayoutGrid', 'Resizer']);
const KNOWN_HOOKS = ['init', 'update', 'onRemove', '_onRenderResize', 'customizeEditor'];

const CACHE_DIR = '.figma-sync-cache';
const CACHE_FILE = 'classes.json';
const CACHE_VERSION = 1;

function readJsonSafe(path) {
	try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function findMonorepoRoot(projectRoot) {
	let dir = resolve(projectRoot);
	for (let i = 0; i < 8; i++) {
		const hasEngine = existsSync(join(dir, 'thing-editor', 'src', 'engine', 'lib', 'assets', 'src'));
		const hasLibs = existsSync(join(dir, 'libs'));
		if (hasEngine && hasLibs) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function walkCTs(root) {
	const out = [];
	if (!existsSync(root)) return out;
	const stack = [root];
	while (stack.length) {
		const cur = stack.pop();
		let entries;
		try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
		for (const ent of entries) {
			const p = join(cur, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
				stack.push(p);
			} else if (ent.isFile() && ent.name.endsWith('.c.ts')) {
				out.push(p);
			}
		}
	}
	return out;
}

function expectedClassNameFromPath(filePath) {
	// `card-item.c.ts` → `CardItem`. Engine uses Class.name at runtime so this
	// is only a fallback for prototype-extended files (no class decl found).
	const base = basename(filePath).replace(/\.c\.ts$/, '');
	return base.split(/[-_]/).map(s => s[0]?.toUpperCase() + s.slice(1)).join('');
}

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:(\w+)(?:\s*,\s*\{[^}]*\})?|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/gm;
const CLASS_RE = /^\s*export\s+default\s+(?:abstract\s+)?class\s+(\w+)\s+extends\s+(\w+)(?:<[^>]*>)?/m;
const HOOK_RE = /^\s*(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(/gm;

function parseFile(filePath, content) {
	const imports = {};
	let m;
	IMPORT_RE.lastIndex = 0;
	while ((m = IMPORT_RE.exec(content))) {
		const def = m[1];
		const from = m[2];
		if (def) imports[def] = from;
	}
	const classMatch = content.match(CLASS_RE);
	const hooks = [];
	if (classMatch) {
		HOOK_RE.lastIndex = 0;
		const body = content.slice(classMatch.index + classMatch[0].length);
		for (const h of KNOWN_HOOKS) {
			if (new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|async\\s+)?${h}\\s*\\(`, 'm').test(body)) {
				hooks.push(h);
			}
		}
	}
	return {
		file: filePath,
		imports,
		className: classMatch?.[1] ?? null,
		parentName: classMatch?.[2] ?? null,
		hooks,
		hasClassDecl: !!classMatch
	};
}

function resolveImportPath(importSpec, fromFile, monorepoRoot) {
	if (importSpec === 'pixi.js') return { kind: 'pixi' };
	if (importSpec.startsWith('thing-editor/')) {
		const sub = importSpec.slice('thing-editor/'.length);
		const candidate = join(monorepoRoot, 'thing-editor', sub + '.ts');
		if (existsSync(candidate)) return { kind: 'file', path: candidate };
		return { kind: 'external', spec: importSpec };
	}
	if (importSpec.startsWith('libs/')) {
		// `libs/sport-ui-lib/assets/src/main-scene.c` → <monorepo>/libs/...
		const candidate = join(monorepoRoot, importSpec + '.ts');
		if (existsSync(candidate)) return { kind: 'file', path: candidate };
		return { kind: 'external', spec: importSpec };
	}
	if (importSpec.startsWith('.')) {
		const dir = dirname(fromFile);
		const candidate = resolve(dir, importSpec + '.ts');
		if (existsSync(candidate)) return { kind: 'file', path: candidate };
		return { kind: 'external', spec: importSpec };
	}
	return { kind: 'external', spec: importSpec };
}

function hashFiles(files) {
	const h = createHash('sha256');
	for (const f of files.slice().sort()) {
		try {
			const s = statSync(f);
			h.update(f);
			h.update(String(s.mtimeMs));
			h.update(String(s.size));
		} catch { /* ignore */ }
	}
	return h.digest('hex');
}

function classifyChain(chain) {
	let anchor = null;
	for (const cls of chain) {
		if (BUILTIN_ANCHORS[cls]) { anchor = BUILTIN_ANCHORS[cls]; break; }
	}
	const isText = chain.some(c => TEXT_CLASSES.has(c));
	const isLayoutManaged = chain.some(c => LAYOUT_CLASSES.has(c));
	return { anchor, isText, isLayoutManaged };
}

function classifySource(filePath, scanRoots) {
	for (const r of scanRoots) {
		if (filePath.startsWith(r.path + '/')) return r.tag;
	}
	return 'unknown';
}

export function loadRegistry(projectRoot, opts = {}) {
	const absProject = resolve(projectRoot);
	const projConfig = readJsonSafe(join(absProject, 'thing-project.json'));
	if (!projConfig) throw new Error(`thing-project.json not found at ${absProject}`);
	const monorepoRoot = findMonorepoRoot(absProject);
	if (!monorepoRoot) throw new Error(`cannot locate monorepo root (with both thing-editor/ and libs/) above ${absProject}`);

	const declaredLibs = Array.isArray(projConfig.libs) ? projConfig.libs : [];

	// Discover all libs under monorepo/libs/ for fallback resolution of
	// undeclared imports (e.g. `libs/sport-ui-lib/...`). Declared libs win
	// priority; other libs scanned as `lib-extra:` (lower priority than declared).
	let allLibs = [];
	try {
		allLibs = readdirSync(join(monorepoRoot, 'libs'), { withFileTypes: true })
			.filter(d => d.isDirectory())
			.map(d => d.name);
	} catch { /* ignore */ }
	const extraLibs = allLibs.filter(l => !declaredLibs.includes(l));

	// Scan roots in priority order. project wins on name collision.
	const scanRoots = [
		{ tag: 'project', path: join(absProject, 'assets', 'src') }
	];
	for (const lib of declaredLibs) {
		scanRoots.push({ tag: `lib:${lib}`, path: join(monorepoRoot, 'libs', lib, 'assets', 'src') });
	}
	for (const lib of extraLibs) {
		scanRoots.push({ tag: `lib-extra:${lib}`, path: join(monorepoRoot, 'libs', lib, 'assets', 'src') });
	}
	scanRoots.push({ tag: 'engine', path: join(monorepoRoot, 'thing-editor', 'src', 'engine', 'lib', 'assets', 'src') });

	const allFiles = [];
	const fileToTag = new Map();
	for (const r of scanRoots) {
		const files = walkCTs(r.path);
		for (const f of files) {
			if (!fileToTag.has(f)) {
				fileToTag.set(f, r.tag);
				allFiles.push(f);
			}
		}
	}

	const buildHash = hashFiles(allFiles);
	const cachePath = join(absProject, CACHE_DIR, CACHE_FILE);
	if (!opts.rebuild && existsSync(cachePath)) {
		const cached = readJsonSafe(cachePath);
		if (cached && cached.version === CACHE_VERSION && cached.buildHash === buildHash) {
			return cached;
		}
	}

	// Parse pass — collect raw decl per file.
	const parsedByFile = new Map();
	for (const file of allFiles) {
		let content;
		try { content = readFileSync(file, 'utf8'); } catch { continue; }
		parsedByFile.set(file, parseFile(file, content));
	}

	// First-pass index: className → primary file (project > lib > engine).
	// Also track conflicts.
	const classToFile = new Map();
	const conflicts = [];
	const rootPriority = (tag) => tag === 'project' ? 0 : tag.startsWith('lib:') ? 1 : tag.startsWith('lib-extra:') ? 2 : tag === 'engine' ? 3 : 4;

	for (const [file, parsed] of parsedByFile) {
		if (!parsed.className) continue;
		const name = parsed.className;
		const tag = fileToTag.get(file);
		const existing = classToFile.get(name);
		if (!existing) {
			classToFile.set(name, { file, tag });
		} else if (rootPriority(tag) < rootPriority(existing.tag)) {
			conflicts.push({ name, kept: { file, tag }, lost: existing });
			classToFile.set(name, { file, tag });
		} else {
			conflicts.push({ name, kept: existing, lost: { file, tag } });
		}
	}

	// Chain resolution: from each class, walk parents until terminator.
	function resolveChain(startName) {
		const chain = [];
		const seen = new Set();
		let cur = startName;
		let unresolvedReason = null;
		while (cur) {
			if (seen.has(cur)) { unresolvedReason = `cyclic at ${cur}`; break; }
			seen.add(cur);
			chain.push(cur);
			if (PIXI_ROOTS.has(cur)) break;
			const entry = classToFile.get(cur);
			if (!entry) { unresolvedReason = `class "${cur}" not found in scan roots`; break; }
			const parsed = parsedByFile.get(entry.file);
			if (!parsed.hasClassDecl) {
				// Prototype-extended file (e.g. container.c.ts). Treat as terminator.
				break;
			}
			if (!parsed.parentName) { unresolvedReason = `class "${cur}" has no parent`; break; }
			// Resolve parent through this class's import map.
			const imp = parsed.imports[parsed.parentName];
			if (imp) {
				const r = resolveImportPath(imp, entry.file, monorepoRoot);
				if (r.kind === 'pixi') {
					chain.push(parsed.parentName);
					break;
				}
				// If import resolves but parent name isn't in our index yet, that's fine —
				// next iteration will lookup by name via classToFile (may still miss).
			}
			cur = parsed.parentName;
		}
		return { chain, unresolvedReason };
	}

	const classes = {};
	const unresolved = [];
	for (const [name, entry] of classToFile) {
		const parsed = parsedByFile.get(entry.file);
		if (!parsed.hasClassDecl) continue; // skip prototype-extended terminators as entries
		const { chain, unresolvedReason } = resolveChain(name);
		const { anchor, isText, isLayoutManaged } = classifyChain(chain);
		classes[name] = {
			file: relative(monorepoRoot, entry.file),
			extends: parsed.parentName,
			chain,
			anchor,
			isText,
			isLayoutManaged,
			hooks: parsed.hooks,
			source: entry.tag
		};
		if (unresolvedReason) {
			classes[name].unresolvedReason = unresolvedReason;
			unresolved.push({ name, reason: unresolvedReason });
		}
	}

	const registry = {
		version: CACHE_VERSION,
		buildHash,
		generatedAt: new Date().toISOString(),
		projectRoot: absProject,
		monorepoRoot,
		scanRoots: scanRoots.map(r => ({ tag: r.tag, path: relative(monorepoRoot, r.path), exists: existsSync(r.path) })),
		fileCount: allFiles.length,
		classes,
		conflicts,
		unresolved
	};

	try {
		mkdirSync(join(absProject, CACHE_DIR), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(registry, null, 2));
	} catch { /* non-fatal */ }

	return registry;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rebuild = args.includes('--rebuild');
	const wantJson = args.includes('--json');
	const root = args.find(a => !a.startsWith('--'));
	if (!root) {
		console.error('usage: project-class-registry.mjs <project-root> [--rebuild] [--json]');
		process.exit(1);
	}
	const reg = loadRegistry(root, { rebuild });
	if (wantJson) {
		process.stdout.write(JSON.stringify(reg, null, 2));
		process.exit(0);
	}
	const classCount = Object.keys(reg.classes).length;
	const projectCount = Object.values(reg.classes).filter(c => c.source === 'project').length;
	const libCount = Object.values(reg.classes).filter(c => c.source.startsWith('lib:')).length;
	const libExtraCount = Object.values(reg.classes).filter(c => c.source.startsWith('lib-extra:')).length;
	const engineCount = Object.values(reg.classes).filter(c => c.source === 'engine').length;
	const layoutCount = Object.values(reg.classes).filter(c => c.isLayoutManaged).length;
	const textCount = Object.values(reg.classes).filter(c => c.isText).length;
	console.log(`Project: ${reg.projectRoot}`);
	console.log(`Monorepo: ${reg.monorepoRoot}`);
	console.log(`Scan roots:`);
	for (const r of reg.scanRoots) console.log(`  [${r.exists ? 'x' : ' '}] ${r.tag.padEnd(28)} ${r.path}`);
	console.log(`Files scanned: ${reg.fileCount}`);
	console.log(`Classes: ${classCount} (project=${projectCount}, lib=${libCount}, lib-extra=${libExtraCount}, engine=${engineCount})`);
	console.log(`  text-bearing: ${textCount}, layout-managed: ${layoutCount}`);
	if (reg.conflicts.length) {
		console.log(`Conflicts (${reg.conflicts.length}):`);
		for (const c of reg.conflicts.slice(0, 10)) {
			console.log(`  ${c.name}: kept ${c.kept.tag}, lost ${c.lost.tag}`);
		}
	}
	if (reg.unresolved.length) {
		console.log(`Unresolved chains (${reg.unresolved.length}):`);
		for (const u of reg.unresolved.slice(0, 20)) console.log(`  ${u.name}: ${u.reason}`);
	}
}
