# Figma Layer Naming Convention

Convention: `[Class] name (meta)`. Soft-enforced — when missing or malformed, AI auto-infers but emits a `warn`.

## Grammar

```
layer-name      = annotation? class-tag? space* identifier (space+ meta)?
                | "_" identifier                  # design-only — skipped entirely
annotation      = ""                              # reserved; no annotations yet
class-tag       = "[" class-token "]"
class-token     = identifier                      # see Recognized below
identifier      = [A-Za-z][A-Za-z0-9_]*
meta            = "(" key-value ("," key-value)* ")"
key-value       = identifier ":" value
value           = number | hex | string | "true" | "false"
hex             = "0x" [0-9A-Fa-f]{1,8}
```

## Recognized class tokens

Single source of truth: `scripts/shared/class-tokens.mjs`.

| Token | Maps to engine class | Notes |
|-------|---------------------|-------|
| `Sprite` | `Sprite` | anchor 0,0 (PixiJS default) |
| `DSprite` | `DSprite` | anchor 0.5,0.5 (constructor sets this) |
| `Text` | `Text` | reads Figma `characters` |
| `Label` | `Text` | alias for common Figma habit |
| `BitmapText` | `BitmapText` | requires installed font; validator warns if missing |
| `HTMLText` | `HTMLText` | rare; passes through |
| `Container` | `Container` | grouping only, no transform of its own |
| `SizedContainer` | `SizedContainer` | width/height are RAW (NOT scaled); different pivot semantics from Sprite |
| `Scene` | `Scene` | top-level only; nested scenes error |
| `Shape` | `Shape` | needs `(shape:..., color:...)` meta |
| `ShapeButton` | `ShapeButton` | inherits Shape, emits click area |
| `Button` | `Button` | sprite-backed clickable |
| `NineSlicePlane` | `NineSlicePlane` | needs `(insets:l,t,r,b)` meta |
| `MovieClip` | `MovieClip` | timeline CANNOT be generated → TODO marker |
| `Mask` | `Mask` | maps Figma boolean/clip mask |
| `Resizer` | `Resizer` | needs `(normAnchor:x,y, normPivot:x,y)` meta |
| `LayoutGroup` | `LayoutGroup` (ui-common-lib) | needs `(direction:..., gap:N)` meta |
| `ScrollLayer` | `ScrollLayer` | x/y must be 0; wrap in container if positioning needed |
| `Trigger` | `Trigger` | conditional visibility; emits TODO for `(cond:...)` |
| `OrientationTrigger` | `OrientationTrigger` | `(mode:portrait\|landscape\|both)` |
| `ParticleContainer` | `ParticleContainer` | |
| `ParticleSystem` | `ParticleSystem` | atlas + emitter; TODO marker (emitter config cannot be generated) |
| `Spawner` | `Spawner` | TODO (prefab reference unknown without code) |
| `Spine` | placeholder | timeline cannot be generated → emits Container + TODO |
| `Prefab` | `"r":"name"` reference | name = .p.json basename in `assets/prefabs/` |
| `ref` | scene-level named child reference | emits NO new node |

## Special tokens

### `[Prefab] name`

Emits prefab reference: `{ "r": "name", "p": { "name": "...", "x": ..., "y": ... } }`.
- Children NOT expanded — they live in `assets/prefabs/<name>.p.json`.
- Validator confirms `.p.json` exists.
- Optional `(variant:variantName)` meta for component sets.

### `[ref] sceneObjectName`

Generator emits NO node. Used when Figma layer represents an entity placed by code (game controllers, dynamically added items).
- In compare workflow: matches existing scene child with `name === sceneObjectName`, diffs position only.
- In validator: error if no such child exists in scene.

### `_layerName` (leading underscore, no class tag)

Design-only annotation. Walker skips entirely. Generator does NOT create a node. Validator does NOT warn.

## Per-class meta annotations

Inside `(...)` after the identifier, comma-separated `key:value`.

| Class | Required meta | Optional meta |
|-------|--------------|--------------|
| `Shape` | `shape:rect\|circle\|ring\|line`, `color:0xRRGGBB` | `radius:N`, `thickness:N` |
| `NineSlicePlane` | `insets:l,t,r,b` | — |
| `Resizer` | `normAnchor:x,y`, `normPivot:x,y` | `stretchAnchor:x,y`, `useWorld:bool` |
| `LayoutGroup` | `direction:row\|col`, `gap:N` | `align:start\|center\|end` |
| `OrientationTrigger` | `mode:portrait\|landscape\|both` | — |
| `Prefab` | — | `variant:variantName` |
| `Text` | — | `align:left\|center\|right`, `vAlign:top\|center\|bottom`, `fontSize:N`, `font:name` |

Unknown meta keys → validator `info` (ignored, not error — allows project-specific extensions).

## Auto-infer fallback rules

When `[Class]` tag is missing, `figma-classify.mjs` infers:

| Figma node shape | Inferred class | Confidence |
|------------------|---------------|------------|
| `TEXT` | `Text` | high |
| `RECTANGLE` with single `IMAGE` fill | `Sprite` | high |
| `RECTANGLE`/`ELLIPSE` with SOLID fill, no children | `Shape` (warn) | medium |
| `FRAME` with image fill + 9-slice corner markers (`_corner*` children) | `NineSlicePlane` | medium |
| `FRAME` with `componentId` matching `figma.connect.json` mapping | `Prefab` | high |
| `FRAME` with children, no fill | `Container` | high |
| `INSTANCE` of `COMPONENT_SET` | `Prefab (variant:<key>)` | high |
| `GROUP` | `Container` (children iterated, no transform) | high |
| `BOOLEAN_OPERATION`, `VECTOR`, `STAR`, `LINE`, `REGULAR_POLYGON` | unsupported → Sprite-stub TODO | low |

All inferences are logged in workflow output so user can promote to explicit tags.

## Examples — GOOD

```
[Container] hud
[Sprite] cardBack
[DSprite] avatar
[Text] scoreLabel
[Text] timerValue (align:right, vAlign:center)
[ShapeButton] playBtn
[NineSlicePlane] dialogPanel (insets:24,24,24,24)
[Shape] divider (shape:rect, color:0x444444)
[Shape] radarCircle (shape:circle, color:0x00FF00, radius:50)
[Prefab] cardItem
[Prefab] cardItem (variant:joker)
[ref] gameController
[Resizer] bottomBar (normAnchor:0.5,1, normPivot:0.5,1, useWorld:true)
[LayoutGroup] toolbar (direction:row, gap:24, align:center)
[OrientationTrigger] mobileOnly (mode:portrait)
_annotationFlag                       # design-only — ignored
_designerNote                         # ignored
```

## Examples — BAD

```
cardBack                              # no class tag → infer warn (N001)
[sprite] cardBack                     # case mismatch → N005 warn
[Sprite cardBack]                     # tag swallows name → N003 error
[Sprite]                              # missing identifier → N003 error
[Sprite] card back                    # space in identifier → N004 error
[Sprite] cardBack (insets:16)         # wrong-class meta → M004 warn
[Sprite] cardBack(insets:16)          # missing space before meta → parse error
[NineSlicePlane] panel                # missing required insets → M001 error
[Shape] divider                       # missing required shape+color → M002 error
[Prefab] doesNotExist                 # no .p.json on disk → P001 error
[ref] noSuchChild                     # no scene child by that name → R001 error
Score                                 # generic name + no tag (infer Text)
```

## Soft enforcement

- Validator workflow surfaces all violations with severity (error/warn/info).
- Compare workflow proceeds even with violations — uses auto-infer where needed.
- Generator workflow proceeds — logs inferences in `.TODO.md` sidecar.

Validators never block other workflows. The catalogue of rule codes lives in `validator-rules.md`.

## Tips for designers

1. **Name buttons explicitly:** `[ShapeButton] playBtn` is much safer than relying on auto-infer for a rect with text inside.
2. **Use `[ref]` for code-placed objects:** if a layer is just a placeholder showing what a runtime-added card looks like, tag it `[ref] cardSlot1`.
3. **Keep names unique within their parent:** `data-paths` like `"this.#playerView"` require unique sibling names. Validator emits `N006` error for duplicates within a parent.
4. **Use `_` prefix for designer annotations:** notes, markups, dev-only labels won't pollute generated scenes.
5. **Prefer `[Container]` over `GROUP`:** groups have no own transform; if you need a positioned container, use a Figma frame with `[Container]` tag.
