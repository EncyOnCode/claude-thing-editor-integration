// Single source of truth for recognized [Class] tokens in Figma layer names.
// Maps token -> { engineClass, anchor, requiredMeta, optionalMeta, notes }
//
// engineClass: name of Thing-Editor class (string). May be null for special tokens.
// anchor: { x, y } default anchor for the class (Pixi default unless engine overrides).
// requiredMeta: array of meta key names that MUST be present.
// optionalMeta: array of allowed meta key names. Unknown keys → M004 warn.
// notes: human-readable behavior notes.

export const CLASS_TOKENS = {
	// Sprites
	Sprite:           { engineClass: 'Sprite',          anchor: { x: 0,   y: 0   }, requiredMeta: [], optionalMeta: [], notes: 'PixiJS default anchor 0,0.' },
	DSprite:          { engineClass: 'DSprite',         anchor: { x: 0.5, y: 0.5 }, requiredMeta: [], optionalMeta: [], notes: 'Constructor sets anchor 0.5,0.5.' },

	// Text
	Text:             { engineClass: 'Text',            anchor: { x: 0,   y: 0   }, requiredMeta: [], optionalMeta: ['align', 'vAlign', 'fontSize', 'font'], notes: 'Reads Figma characters.' },
	Label:            { engineClass: 'Text',            anchor: { x: 0,   y: 0   }, requiredMeta: [], optionalMeta: ['align', 'vAlign', 'fontSize', 'font'], notes: 'Alias for Text.' },
	BitmapText:       { engineClass: 'BitmapText',      anchor: { x: 0,   y: 0   }, requiredMeta: [], optionalMeta: ['align', 'fontSize', 'font'], notes: 'Requires .fnt + atlas in assets/fonts/.' },
	HTMLText:         { engineClass: 'HTMLText',        anchor: { x: 0,   y: 0   }, requiredMeta: [], optionalMeta: ['align', 'fontSize', 'font'], notes: 'Rare; pass-through.' },

	// Containers
	Container:        { engineClass: 'Container',       anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Grouping only, no own transform.' },
	SizedContainer:   { engineClass: 'SizedContainer',  anchor: null,               requiredMeta: [], optionalMeta: ['width', 'height'], notes: 'width/height RAW (not scaled).' },
	Scene:            { engineClass: 'Scene',           anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Top-level only; nested errors.' },

	// Shapes
	Shape:            { engineClass: 'Shape',           anchor: { x: 0,   y: 0   }, requiredMeta: ['shape', 'color'], optionalMeta: ['radius', 'thickness'], notes: 'shape: rect|circle|ring|line.' },
	ShapeButton:      { engineClass: 'ShapeButton',     anchor: { x: 0,   y: 0   }, requiredMeta: ['shape', 'color'], optionalMeta: ['radius', 'thickness'], notes: 'Inherits Shape; emits click area.' },
	Button:           { engineClass: 'Button',          anchor: { x: 0.5, y: 0.5 }, requiredMeta: [], optionalMeta: [], notes: 'Sprite-backed clickable.' },
	NineSlicePlane:   { engineClass: 'NineSlicePlane',  anchor: { x: 0,   y: 0   }, requiredMeta: ['insets'], optionalMeta: [], notes: 'insets: l,t,r,b.' },

	// Animated / interactive
	MovieClip:        { engineClass: 'MovieClip',       anchor: { x: 0.5, y: 0.5 }, requiredMeta: [], optionalMeta: [], notes: 'Timeline CANNOT be generated → TODO.' },
	Mask:             { engineClass: 'Mask',            anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Maps Figma boolean/clip mask.' },
	ScrollLayer:      { engineClass: 'ScrollLayer',     anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'x/y must be 0; wrap if positioning needed.' },
	Trigger:          { engineClass: 'Trigger',         anchor: null,               requiredMeta: [], optionalMeta: ['cond'], notes: 'Conditional visibility; emits TODO for cond.' },
	OrientationTrigger: { engineClass: 'OrientationTrigger', anchor: null,         requiredMeta: ['mode'], optionalMeta: [], notes: 'mode: portrait|landscape|both.' },

	// Layout
	Resizer:          { engineClass: 'Resizer',         anchor: null,               requiredMeta: ['normAnchor', 'normPivot'], optionalMeta: ['stretchAnchor', 'useWorld'], notes: 'canOverridePivotAndAnchor forced true.' },
	LayoutGroup:      { engineClass: 'LayoutGroup',     anchor: null,               requiredMeta: ['direction', 'gap'], optionalMeta: ['align'], notes: 'ui-common-lib flex-style layout.' },

	// Particles
	ParticleContainer: { engineClass: 'ParticleContainer', anchor: null,           requiredMeta: [], optionalMeta: [], notes: 'Optimization container.' },
	ParticleSystem:   { engineClass: 'ParticleSystem',  anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Atlas + emitter config CANNOT be generated → TODO.' },
	Spawner:          { engineClass: 'Spawner',         anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Prefab reference unknown without code → TODO.' },

	// Placeholder
	Spine:            { engineClass: null,              anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'Placeholder; emits Container + TODO.' },

	// Special
	Prefab:           { engineClass: '__PREFAB_REF__',  anchor: null,               requiredMeta: [], optionalMeta: ['variant'], notes: 'Emits "r":"name" reference; children NOT expanded.' },
	ref:              { engineClass: '__SCENE_REF__',   anchor: null,               requiredMeta: [], optionalMeta: [], notes: 'No node emitted; references existing scene-level named child.' }
};

export const SPECIAL_TOKENS = new Set(['Prefab', 'ref']);

// Aliases (case-insensitive lookup support for N005 warn).
export const ALIASES = {
	label: 'Label',
	prefab: 'Prefab',
	REF: 'ref',
	Ref: 'ref'
};

// Text-bearing classes (used by scene-walker hasTextDescendant + apply-patch text guard).
export const TEXT_CLASSES = new Set(['Text', 'Label', 'BitmapText', 'HTMLText']);
export const LAYOUT_MANAGED_CLASSES = new Set(['LayoutGroup', 'LayoutGrid', 'Resizer']);

// Project-scanned custom classes registered at runtime via extendTokens(registry).
// Module state — each subprocess that consumes --project must call extendTokens
// after loading its registry; state does not survive across processes.
const EXTRA_TOKENS = {};
const EXTRA_LAYOUT_MANAGED = new Set();
const EXTRA_TEXT_CLASSES = new Set();

export function extendTokens(registry) {
	if (!registry?.classes) return;
	for (const [name, info] of Object.entries(registry.classes)) {
		if (CLASS_TOKENS[name]) continue; // builtin wins
		EXTRA_TOKENS[name] = {
			engineClass: name,
			anchor: info.anchor ?? null,
			requiredMeta: [],
			optionalMeta: [],
			notes: `custom class from ${info.source} (chain: ${info.chain.join(' -> ')})`,
			chain: info.chain,
			source: info.source,
			custom: true
		};
		if (info.isLayoutManaged) EXTRA_LAYOUT_MANAGED.add(name);
		if (info.isText) EXTRA_TEXT_CLASSES.add(name);
	}
}

export function getTokenSpec(token) {
	return CLASS_TOKENS[token] || EXTRA_TOKENS[token] || null;
}

export function isLayoutManaged(cls) {
	if (!cls) return false;
	if (LAYOUT_MANAGED_CLASSES.has(cls)) return true;
	return EXTRA_LAYOUT_MANAGED.has(cls);
}

// Returns canonical token if input matches (case-sensitive) OR null.
export function resolveToken(raw) {
	if (CLASS_TOKENS[raw]) return { token: raw, caseMatch: true };
	if (EXTRA_TOKENS[raw]) return { token: raw, caseMatch: true, custom: true };
	if (ALIASES[raw]) return { token: ALIASES[raw], caseMatch: true };
	// Case-insensitive fallback for N005 warn.
	const lower = raw.toLowerCase();
	for (const known of Object.keys(CLASS_TOKENS)) {
		if (known.toLowerCase() === lower) return { token: known, caseMatch: false };
	}
	for (const known of Object.keys(EXTRA_TOKENS)) {
		if (known.toLowerCase() === lower) return { token: known, caseMatch: false, custom: true };
	}
	for (const alias of Object.keys(ALIASES)) {
		if (alias.toLowerCase() === lower) return { token: ALIASES[alias], caseMatch: false };
	}
	return null;
}

export function isTextClass(cls) {
	if (!cls) return false;
	if (TEXT_CLASSES.has(cls)) return true;
	return EXTRA_TEXT_CLASSES.has(cls);
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const tests = [
		['Sprite', { token: 'Sprite', caseMatch: true }],
		['sprite', { token: 'Sprite', caseMatch: false }],
		['Label', { token: 'Label', caseMatch: true }],
		['REF', { token: 'ref', caseMatch: true }],
		['Unknown', null]
	];
	let fail = 0;
	for (const [input, expected] of tests) {
		const got = resolveToken(input);
		const ok = JSON.stringify(got) === JSON.stringify(expected);
		console.log(`${ok ? 'PASS' : 'FAIL'} resolveToken(${input}) = ${JSON.stringify(got)}`);
		if (!ok) fail++;
	}
	console.log(`\n${Object.keys(CLASS_TOKENS).length} tokens, ${Object.keys(ALIASES).length} aliases, ${TEXT_CLASSES.size} text classes`);
	process.exit(fail);
}
