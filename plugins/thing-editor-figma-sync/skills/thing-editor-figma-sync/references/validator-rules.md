# Validator Rules Catalogue

Workflow B (`naming-validator.mjs`) emits issues with rule codes + severity.

Exit codes:
- `0` — only `info` (or no findings)
- `1` — at least one `warn`
- `2` — at least one `error`

**Soft enforcement:** validator NEVER blocks compare/generate workflows. Even with errors, those workflows proceed using auto-infer fallbacks.

## Naming (N-series)

### N001 — `warn` — no `[Class]` tag

```
[warn] N001 cardBack — no [Class] tag, inferred as Sprite
```

**Cause:** layer name has no `[Class]` prefix.
**Fix:** add explicit `[Class]` for stability across redesigns.
**Inferred class:** see auto-infer table in `naming-conventions.md`.

### N002 — `error` — unknown class token

```
[error] N002 [Sprie] cardBack — unknown class token "Sprie"
```

**Cause:** class in `[...]` is not in recognized list.
**Fix:** check spelling against `class-tokens.mjs` exports.

### N003 — `error` — missing identifier after `[Class]`

```
[error] N003 [Sprite] — missing identifier
```

**Cause:** class tag with no following name.
**Fix:** add identifier (e.g. `[Sprite] cardBack`).

### N004 — `error` — identifier contains invalid chars

```
[error] N004 [Sprite] card back — invalid identifier "card back" (spaces, hyphens not allowed)
```

**Cause:** spaces, hyphens, dots, or symbols in identifier.
**Fix:** use camelCase or snake_case only.

### N005 — `warn` — class token case mismatch

```
[warn] N005 [sprite] cardBack — class token "sprite" should be "Sprite"
```

**Cause:** PascalCase mismatch.
**Fix:** match exact case from recognized tokens list.

### N006 — `error` — duplicate name within parent

```
[error] N006 hud/scoreLabel — duplicate name within parent "hud" (also at hud/scoreLabel)
```

**Cause:** two siblings with same `name`. Breaks `data-paths` like `"this.#scoreLabel"`.
**Fix:** rename one (e.g. `scoreLabel1`, `scoreLabel2` or use semantic differentiation).

### N007 — `warn` — duplicate leaf name across different parents

```
[warn] N007 avatar — appears 3 times (players/p1/avatar, players/p2/avatar, players/p3/avatar)
```

**Cause:** same leaf name in multiple parents. Composite-key matching handles this in compare, but fragile.
**Fix:** prefer fully-qualified scene path matching OR rename for uniqueness.

## Meta annotations (M-series)

### M001 — `error` — `[NineSlicePlane]` missing required `(insets:...)`

```
[error] M001 [NineSlicePlane] panel — missing required meta (insets:l,t,r,b)
```

**Cause:** NineSlicePlane needs slice insets to know where to scale.
**Fix:** add `(insets:16,16,16,16)` for uniform 16px corners.

### M002 — `error` — `[Shape]` missing required `(shape:..., color:...)`

```
[error] M002 [Shape] divider — missing required meta (shape:..., color:0x...)
```

**Cause:** Shape needs explicit primitive type + color.
**Fix:** `[Shape] divider (shape:rect, color:0x444444)`.

### M003 — `error` — `[Resizer]` missing required meta

```
[error] M003 [Resizer] bottomBar — missing required meta keys (normAnchor:x,y, normPivot:x,y)
```

**Cause:** Resizer needs normalized anchor + pivot to know how to resize.
**Fix:** `[Resizer] bottomBar (normAnchor:0.5,1, normPivot:0.5,1)`.

### M004 — `warn` — unknown meta key

```
[warn] M004 [Sprite] cardBack (insets:16) — unknown meta key "insets" for class Sprite
```

**Cause:** meta key not applicable to this class.
**Fix:** remove or move to the correct class (insets only on NineSlicePlane).

### M005 — `error` — meta value type mismatch

```
[error] M005 [Shape] divider (color:gray) — meta "color" expected hex int (e.g. 0xRRGGBB), got "gray"
```

**Cause:** value doesn't match expected type (hex int / number / boolean).
**Fix:** use proper literal: `0x444444`, not `gray`.

## Prefab/Reference (P/R-series)

### P001 — `error` — `[Prefab] foo` but `assets/prefabs/foo.p.json` not found

```
[error] P001 [Prefab] cardItem — assets/prefabs/cardItem.p.json not found
```

**Cause:** Figma references a prefab that doesn't exist on disk.
**Fix:** create the prefab in editor, OR rename the Figma layer to match an existing one, OR change tag to `[Container]` if it's not actually a prefab.
**Requires `--project <path>` flag.**

### P002 — `warn` — Figma `COMPONENT_SET` not mapped

```
[warn] P002 button-set (Figma node 1:23) — COMPONENT_SET not in figma.connect.json
```

**Cause:** Figma component set has no entry in `<project>/figma.connect.json`.
**Fix:** add a mapping entry pointing to a prefab name, OR ignore if intentional.

### P003 — `info` — Figma `INSTANCE` matched to prefab via componentId

```
[info] P003 [Prefab] avatar — matched to assets/prefabs/avatar.p.json via componentId
```

Confirmation that auto-match worked. No action needed.

### R001 — `error` — `[ref] foo` but scene has no child `foo`

```
[error] R001 [ref] gameController — no child named "gameController" found in scene
```

**Cause:** Figma `[ref]` points to a scene-side name that doesn't exist.
**Fix:** create the named object in scene OR remove `[ref]` if obsolete.
**Requires `--scene <path>` flag.**

## Structural (S-series)

### S001 — `warn` — unsupported Figma construct

```
[warn] S001 myUnion (BOOLEAN_OPERATION) — unsupported, will become Sprite-export TODO
```

**Cause:** Figma boolean op, complex vector, star, line, polygon.
**Fix:** flatten to a rect with image fill in Figma, OR export as PNG and reference via `[Sprite]` with image fill.

### S002 — `warn` — drop-shadow / blur effect detected

```
[warn] S002 cardFrame — drop-shadow effect → can map to DropShadowFilter
```

**Cause:** Figma layer has filter effects.
**Fix:** Thing-Editor supports `DropShadowFilter` with default params; generator emits wrapper with TODO for custom params.

### S003 — `info` — Mask/clip layer detected

```
[info] S003 cardArt — mask layer → maps to Mask component
```

Confirmation that mask is recognized. No action needed.

## Text (T-series)

### T001 — `warn` — `[Text]` center/center Y unreliable

```
[warn] T001 [Text] timerValue (align:center, vAlign:center) — Y position derivation from Figma is unreliable
```

**Cause:** Pixi text height ≠ Figma text height (Pixi uses full line metrics, Figma uses tight glyph bbox).
**Fix:** prefer `vAlign:top` or `vAlign:bottom` for predictable Y patches, OR verify Y position visually after generation/patch.

### T002 — `warn` — `[BitmapText]` font not found

```
[warn] T002 [BitmapText] score (font:myFont) — font "myFont" not in assets/fonts/
```

**Cause:** BitmapText needs a `.fnt` + image atlas in `assets/fonts/`.
**Fix:** install the BitmapFont OR switch to `[Text]` (uses system/web fonts).
**Requires `--project <path>` flag.**

## OrientationTrigger (O-series)

### O001 — `info` — OrientationTrigger dual variants detected

```
[info] O001 hud — OrientationTrigger detected with both portrait and landscape variants
```

Confirmation that generator will merge sibling frames `[OrientationTrigger] hud (mode:portrait)` + `(mode:landscape)` into single node with variant props.

## Structural errors (C-series)

### C001 — `error` — `[Scene]` nested inside another node

```
[error] C001 [Scene] subScene — Scene must be top-level; cannot be nested
```

**Cause:** `Scene` is reserved for root only.
**Fix:** use `[Container]` for nested grouping.

## Output format example

```
=== Figma naming validation ===
file: abc123XYZ / node: 1:1
scanned: 142 layers (38 skipped with _ prefix)

[error] N006   players/avatar       — duplicate within parent
[error] P001   [Prefab] cardItem    — assets/prefabs/cardItem.p.json not found
[warn]  N001   loginButton          — no [Class] tag, inferred as Sprite
[warn]  T001   [Text] scoreLabel    — center/center Y is unreliable
[info]  P003   [Prefab] avatar      — matched to avatar.p.json via componentId

Summary: 2 error, 2 warn, 1 info  (exit 2)
```

## JSON output mode

With `--json <path>`, emits machine-readable findings:

```json
{
  "scanned": 142,
  "skipped": 38,
  "findings": [
    {
      "code": "N006",
      "severity": "error",
      "figmaPath": "players/avatar",
      "figmaNodeId": "1:23",
      "message": "duplicate within parent",
      "details": { "duplicates": ["1:23", "1:42"] }
    }
  ],
  "summary": { "error": 2, "warn": 2, "info": 1, "exitCode": 2 }
}
```
