# Skeleton Generator Rules (Workflow C)

`generate-skeleton.mjs` walks a Figma snapshot and produces `.s.json` / `.p.json` + `.TODO.md` sidecar.

## Decision tree per Figma node

```
1. SKIP rules
   ├─ name starts with "_" → skip entirely (no node emitted)
   ├─ type ∈ {SECTION, STICKY, COMMENT} → skip
   └─ visible = false → skip (or emit with visible:false if explicitly tagged)

2. CLASSIFY
   ├─ name matches /^\[(\w+)\]\s+(\w+)(\s+\((.*)\))?$/ → use explicit class + meta
   └─ no tag → auto-infer (table below)

3. GEOMETRY (via coord-resolve.mjs)
   ├─ Compute x, y from absoluteBoundingBox relative to parent
   ├─ Apply per-class anchor conversion (see coord-mapping.md):
   │   ├─ Sprite: x = figma.x; y = figma.y (anchor 0,0)
   │   ├─ DSprite: x = figma.x + w/2; y = figma.y + h/2 (anchor 0.5,0.5)
   │   ├─ Text: x = figma.x + w*anchor.x; y = figma.y + h*anchor.y
   │   └─ ...
   ├─ Width/height for SizedContainer, NineSlicePlane, Shape
   ├─ scale.x/y ONLY for Sprite with image fill (lookup texture base via texture-base.mjs)
   │   → REFUSE for Text or Text-ancestor (would resample/blur)
   ├─ tint from solid fill (omit if no fill, omit if 0xFFFFFF white)
   ├─ alpha from opacity (skip if 1.0)
   └─ rotation deg → rad (skip if 0)

4. CLASS-SPECIFIC EMIT (see table below)

5. RECURSE into children (under ":")
```

## Auto-infer table

When `[Class]` is absent:

| Figma node | Inferred class | Notes |
|------------|---------------|-------|
| `TEXT` | `Text` | Reads `characters` + `style.*` |
| `RECTANGLE` + IMAGE fill | `Sprite` | Resolves image asset |
| `RECTANGLE`/`ELLIPSE` + SOLID fill, no children | `Shape` | warn: prefer explicit `[Shape] name (shape:rect, color:0x...)` |
| `FRAME` + image + `_corner*` children | `NineSlicePlane` | medium confidence |
| `FRAME` + matching `componentId` in `figma.connect.json` | `Prefab` | high confidence |
| `FRAME` + children, no fill | `Container` | high confidence |
| `INSTANCE` of `COMPONENT_SET` | `Prefab (variant:<key>)` | uses variantMap from connect-map |
| `GROUP` | `Container` (flatten) | children iterated, no own transform |
| `BOOLEAN_OPERATION`, `VECTOR`, `STAR`, `LINE` | unsupported → Sprite-stub TODO | low confidence |

All auto-inferences logged in `.TODO.md` sidecar.

## Class-specific emit shapes

### Sprite

```json
{
  "c": "Sprite",
  "p": {
    "name": "cardBack",
    "x": 100, "y": 200,
    "image": "img/cards/cardBack.png",
    "tint": 16776960,        // omit if 0xFFFFFF
    "alpha": 0.8             // omit if 1.0
  }
}
```

If texture base size found via `texture-base.mjs`: also emit `scale.x`/`scale.y`. Otherwise TODO.

### DSprite

Same as Sprite but `x`/`y` shifted by `+width/2`/`+height/2` to account for 0.5/0.5 anchor.

### Text

```json
{
  "c": "Text",
  "p": {
    "name": "scoreLabel",
    "x": 100, "y": 200,
    "text": "Score: 0",
    "style.fontSize": 24,
    "style.fill": 16777215,
    "style.fontFamily": "Roboto",
    "style.align": "center",
    "anchor.x": 0.5,         // derived from align
    "anchor.y": 0.5          // derived from vAlign
  }
}
```

If `style.fontFamily` matches L10n key pattern OR text appears localizable: emit `___TODO: "Likely L10n — convert to translatableText with project key"` and list in sidecar.

### NineSlicePlane

```json
{
  "c": "NineSlicePlane",
  "p": {
    "name": "dialogPanel",
    "x": 100, "y": 200,
    "width": 400, "height": 300,
    "image": "img/ui/dialogPanel.png",
    "leftWidth": 24, "rightWidth": 24,
    "topHeight": 24, "bottomHeight": 24
  }
}
```

Insets from `(insets:l,t,r,b)` meta.

### Shape

```json
{
  "c": "Shape",
  "p": {
    "name": "divider",
    "x": 100, "y": 200,
    "width": 200, "height": 2,
    "shape": "rect",
    "shapeFillColor": 4473924,        // from (color:0x444444)
    "shapeRadius": 8                  // if shape:round-rect or circle
  }
}
```

### Container / SizedContainer

```json
{
  "c": "Container",
  "p": {
    "name": "hud",
    "x": 0, "y": 0
  },
  ":": [ /* children */ ]
}
```

SizedContainer additionally emits `width`/`height`.

### Prefab reference

```json
{
  "r": "cardItem",
  "p": {
    "name": "p1Card1",
    "x": 100, "y": 200
  }
}
```

NO children emitted (live in `assets/prefabs/cardItem.p.json`).

If `(variant:joker)` meta: lookup `variantMap` in connect-map for the actual prefab name.

### Resizer

```json
{
  "c": "Resizer",
  "p": {
    "name": "bottomBar",
    "canOverridePivotAndAnchor": true,
    "normAnchorX": 0.5, "normAnchorY": 1,
    "normPivotX": 0.5, "normPivotY": 1,
    "stretchAnchorX": 0, "stretchAnchorY": 0,
    "useWorld": true
  },
  ":": [ /* children */ ]
}
```

`canOverridePivotAndAnchor:true` is FORCED for Resizer (otherwise `norm*` props are ignored).

### OrientationTrigger

**Special:** merge sibling frames `[OrientationTrigger] hud (mode:portrait)` + `[OrientationTrigger] hud (mode:landscape)` into ONE node:

```json
{
  "c": "OrientationTrigger",
  "p": {
    "name": "hud",
    "portraitX": 0, "portraitY": 100,
    "portraitScaleX": 1, "portraitScaleY": 1,
    "landscapeX": 0, "landscapeY": 50,
    "landscapeScaleX": 1.2, "landscapeScaleY": 1.2
  },
  ":": [ /* children from BOTH variants merged */ ]
}
```

If only one variant present in Figma: emit single side, sidecar TODO for the other.

### LayoutGroup

```json
{
  "c": "LayoutGroup",
  "p": {
    "name": "toolbar",
    "x": 0, "y": 0,
    "orientation": "Horizontal",     // from (direction:row→Horizontal, col→Vertical)
    "spacingX": 24,                  // from (gap:24)
    "aligmentX": 0.5                 // from (align:center → 0.5)
  },
  ":": [ /* children */ ]
}
```

### ref (no node)

`[ref] sceneObjectName` emits NO node. Adds TODO entry to sidecar:
```
- [ ] `[ref] gameController` — code-side construction expected; no node generated.
```

### Spine / MovieClip / ParticleSystem

Emits placeholder Container with TODO marker:
```json
{
  "c": "Container",
  "p": { "name": "coinSpinFx" },
  "___TODO": "[MovieClip] coinSpinFx — timeline cannot be generated. Author in editor.",
  ":": []
}
```

## TODO marker convention

### Inline `___TODO`

Triple underscore prefix. Engine's `fs.fieldsFilter` (in `thing-editor/src/editor/fs.ts:616-620`) strips `___*` keys on save. So markers are visible in the generated JSON but DO NOT persist to disk after the user opens the file in editor.

```json
{
  "c": "Text",
  "p": {
    "name": "scoreLabel",
    "text": "Score"
  },
  "___TODO": "Likely L10n — convert to translatableText"
}
```

**WARNING:** review the `.TODO.md` sidecar BEFORE first save in the editor. Once saved, inline `___TODO` markers are gone.

### Sidecar `.TODO.md`

Written next to output (e.g. `out.s.json` → `out.TODO.md`).

```markdown
# TODO: assets/main.s.json (generated 2026-05-20)

## High priority — must address before scene works

- [ ] `[ref] gameController` — no node generated. Add code-side construction.
- [ ] `[Prefab] cardItem` — assets/prefabs/cardItem.p.json missing. Create prefab or change tag to `[Container]`.

## Medium priority — likely wrong, verify

- [ ] `[Text] scoreLabel` — possibly L10n. Convert to `translatableText` with project L10n key.
- [ ] `[Sprite] cardBack` — image asset `img/cards/cardBack.png` not found. Place file or update prop.
- [ ] `cardBack` (no [Class] tag) — auto-inferred as Sprite. Promote to explicit `[Sprite] cardBack`.

## Low priority — informational

- [ ] `[MovieClip] coinSpinFx` — timeline cannot be generated. Author in editor.
- [ ] `vsBlend` — drop-shadow effect → wrap in DropShadowFilter.
- [ ] 4 layers inferred without [Class] tag — see validation output.

## Engine fields not auto-emitted

For each generated class, reference `thing-editor-deep/references/03-components.md` for the full @editable field list.
```

## What the generator CANNOT do

- **Data-paths** (`"this.#child"`, `"all.cardFactory"`) — no Figma representation.
- **Callbacks** (`onClick: ["this.handleClick"]`) — game logic.
- **DI tokens** (tsyringe `@inject(EventBusToken)`) — code-only.
- **Custom controller classes** (e.g. `BalanceViewController`) — emits as `Text` + TODO.
- **MovieClip timelines** — author in editor.
- **Spine skeletons** — bone animations not in Figma.
- **`translatableText` keys** — L10n table is project data.
- **Editor-only flags** (`__deepness`, `__lockSelection`).

## Effects mapping

| Figma effect | Thing-Editor equivalent | Generator behavior |
|--------------|------------------------|--------------------|
| `DROP_SHADOW` | `DropShadowFilter` | Emit wrapper container with default filter params; TODO for custom params |
| `INNER_SHADOW` | unsupported | TODO marker |
| `LAYER_BLUR` | `BlurFilter` | Emit wrapper with default blur amount; TODO for custom |
| `BACKGROUND_BLUR` | unsupported | TODO marker |

## INSTANCE overrides

When Figma `INSTANCE` overrides text or fill from its main component, emit overrides on the prefab instance:

```json
{
  "r": "cardItem",
  "p": {
    "name": "p1Card1",
    "x": 100, "y": 200,
    "text": "Joker",           // overrides prefab's default text
    "tint": 16711680           // overrides prefab's default tint
  }
}
```

## CLI invocation

```
node generate-skeleton.mjs \
  --figma <snapshot.json> \
  --out <path/to/out.{s,p}.json> \
  [--prefab]                       # emits Container root (no Scene wrapper)
  [--project <path>]               # enables prefab existence + texture-base checks
  [--connect <figma.connect.json>] # for component → prefab mapping
  [--root-class Main|Scene|Container]
  [--orientation portrait|landscape]
  [--dry]                          # print to stdout, no write
```

## Cross-links

- Per-class @editable fields: `thing-editor-deep/references/03-components.md`
- Coordinate conversions: `coord-mapping.md`
- Pivot trap + per-class width semantics: `engine-coordinates.md` §4
- NodeExtendData (editor metadata, NOT serialized): `thing-editor-deep/references/08-types.md`
