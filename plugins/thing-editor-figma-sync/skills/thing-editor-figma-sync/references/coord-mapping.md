# Coord / Color / Rotation Mapping — Figma → Thing-Editor

Thing-Editor has TWO coordinate systems that coexist on every node:

1. **Static PixiJS** — direct `x`/`y`/`pivot.x`/`pivot.y`/`width`/`height` in JSON. Read once at init.
2. **Resize-driven** — engine computes `position`/`pivot`/`width`/`height` from normalized attributes (`normAnchor*`, `normPivot*`, `stretchAnchor*`, `normalizePos*`, `margin*`). Recomputed on every `_onRenderResize` (init, addChild, window resize, editor property change).

Knowing which system controls a given node is mandatory before patching — writing the wrong key is a silent no-op because the engine overwrites it.

## Coordinate origin

| System | Origin | Y axis |
|---|---|---|
| Figma node `absoluteBoundingBox` | top-left of canvas | down+ |
| Thing-Editor scene | parent-local | down+ |
| Thing-Editor stage | (0,0) at top-left of `game.W × game.H` | down+ |

Both Y down. Sign agrees. Only origin differs.

## Engine source of truth

- `thing-editor/src/engine/utils/resize-attrib.ts` — `recalculateCoordinates()` (the resize-driven path)
- `thing-editor/src/engine/lib/assets/src/extended/sized-container.c.ts` — explicit width/height storage
- `libs/ui-common-lib/assets/src/custom/layout-group.c.ts` — `LayoutGroup.layoutChildren()` (positions children by itself)

---

## Decision tree — which props can I patch?

For each scene node N, check **in this order**:

### 1. Is N a child of a layout-managed parent?

A "layout-managed parent" = parent's class is one of:
- `LayoutGroup`
- `LayoutGrid`
- `Resizer`

If yes:
- ❌ `x`, `y` — overwritten by `parent.layoutChildren()`. Do not patch.
- ⚠️ `width`, `height` — may be overwritten if parent has `sizeModeH/V` ∈ `{both, stretch, shrink}`. Otherwise OK.
- ✓ Other props (style, image, tint, normPivot, etc.) — fine.
- To shift this child visually, change the **parent**:
  - `parent.spacingX/Y`
  - `parent.paddingLeft/Right/Top/Bottom`
  - `parent.aligmentX/Y` (0..1)
  - Reorder children (`childIndex`)
  - Insert a spacer container

### 2. Does N have `canOverridePivotAndAnchor: true`?

If no → static PixiJS path. Patch `x`, `y`, `pivot.x`, `pivot.y`, `width`, `height` directly. Done.

If yes → resize-driven path. Continue.

### 3. Resize-driven path — figure out effective parent

Engine `recalculateCoordinates()` picks the effective parent like this:

```
if N.useTextCoordinate && N.parent is Text:
  effectiveParent = N.parent (Text)
elif N.findNearestParent:
  effectiveParent = walk up until Shape | SizedContainer
else:
  effectiveParent = N.parent

if N.useWorld:
  parentW, parentH = game.W, game.H        # ignore real parent's size
else:
  parentW, parentH = effectiveParent.width, effectiveParent.height
```

### 4. Sprite fast-path — `tryRecalculateSprite()`

Triggered ONLY when ALL of:
- `N instanceof Sprite`
- `N.stretchAnchorX > 0 || N.stretchAnchorY > 0`
- `N.fit !== 'none'` (one of `stretch`, `contain`, `cover`)
- `N.texture` is present
- `parentW && parentH`

In this mode:
- `N.width`, `N.height` — computed from texture × parent × fit. ❌ Do not patch.
- `N.position` — computed from `normAnchor`/`normalizePos`/margins. ❌ Do not patch `x`/`y`.

### 5. General resize path

```
# Position (only runs if useWorld OR effectiveParent.aligmentX is 0/undefined)
targetX = parentW × normAnchorX
targetY = parentH × normAnchorY

if stretchAnchorX > 0 AND N is not Text:
  N.width = parentW × stretchAnchorX − marginLeft − marginRight
  targetX += (marginLeft − marginRight) × 0.5
if stretchAnchorY > 0 AND N is not Text:
  N.height = parentH × stretchAnchorY − marginTop − marginBottom
  targetY += (marginTop − marginBottom) × 0.5

targetX += normalizePosX
targetY += normalizePosY

N.position.set(targetX, targetY)

# Pivot — ALWAYS recomputed (no guard)
N.pivot.x = N.width × normPivotX
N.pivot.y = N.height × normPivotY
```

### What to patch under canOverridePivotAndAnchor

| Goal | Patch this (NOT x/y/pivot) |
|------|----------------------------|
| Shift X by Δpx | `normalizePosX` += Δ |
| Shift Y by Δpx | `normalizePosY` += Δ |
| Change horizontal anchor fraction | `normAnchorX` (0..1, fraction of parentW) |
| Change vertical anchor fraction | `normAnchorY` (0..1, fraction of parentH) |
| Change pivot fraction | `normPivotX` / `normPivotY` (0..1, fraction of own width/height) |
| Width X% of parent | `stretchAnchorX` (0..1); leave width alone |
| Trim stretch from sides | `marginLeft` / `marginRight` |

### What stays patch-safe even with canOverridePivotAndAnchor

- `width` / `height` — **only** if no stretchAnchor on that axis
- `pivot.x` / `pivot.y` — **never**, always overwritten via `normPivot * width`
- `x` / `y` — only if general-path is gated off (parent.aligmentX > 0 AND useWorld false)

---

## Translate Figma → resize-driven scene position

Given Figma node F top-left `(fx, fy)` and size `(fw, fh)` in scene-root coords; node N with `canOverridePivotAndAnchor: true`, no stretch:

```
# After engine recalc:
visual_top_left_x = (parentW × normAnchorX + normalizePosX) − (N.width × normPivotX)
visual_top_left_y = (parentH × normAnchorY + normalizePosY) − (N.height × normPivotY)
```

Solve for `normalizePosX` (cheapest fix — pixel offset, no fraction changes):

```
normalizePosX = fx − parentW × normAnchorX + N.width × normPivotX
normalizePosY = fy − parentH × normAnchorY + N.height × normPivotY
```

**Worked example** (a header pinned bottom-left):
- N has `normAnchorX: 0`, `normAnchorY: 1`, `normPivotX: 0`, `normPivotY: 1`, `N.width: 200`, `N.height: 60`
- parent is `useWorld` → parentW=1920, parentH=1080
- Figma wants visual top-left at (24, 1000)
- `normalizePosX = 24 − 1920×0 + 200×0 = 24`
- `normalizePosY = 1000 − 1080×1 + 60×1 = 1000 − 1080 + 60 = −20`

With stretch (stretchAnchorX > 0), substitute N.width with the computed stretched width and add the margin-center term:

```
stretchedWidth = parentW × stretchAnchorX − marginLeft − marginRight
visual_top_left_x = parentW × normAnchorX + (marginLeft − marginRight) × 0.5 + normalizePosX − stretchedWidth × normPivotX
```

---

## Figma bounding box — critical rule

**Figma always reports the TOP-LEFT corner** of a node's bounding box via `absoluteBoundingBox` and `locationRelativeToParent`. This applies to frames, groups, instances, and autolayout frames — regardless of their content or anchor.

For autolayout frames with `sizing: hug`: the bbox wraps all children tightly. The top-left of the bbox is the top-left of the outermost visible content.

---

## Anchor adjust — STATIC path only

Use only when `canOverridePivotAndAnchor` is false/undefined.

| Class | Default anchor | Convert (parent-local) |
|---|---|---|
| `Container` / `SizedContainer` | n/a (no anchor) | `x = figma.x − parentTopLeft.x; y = figma.y − parentTopLeft.y` |
| `Sprite` | (0, 0) | same as Container |
| `DSprite` | (0.5, 0.5) | `x = figma.x + figma.width/2; y = figma.y + figma.height/2` |
| `MovieClip` | (0.5, 0.5) | same as DSprite |
| `Text` | configurable via `style.align`/`verticalAlign` derived `anchor.x/y` — see Text section | depends on align |
| `NineSlicePlane` | (0, 0) | `x = figma.x; y = figma.y` |
| `Shape` | (0, 0) but draws around `pivot` | `x = figma.x + (pivot.x or 0); y = figma.y + (pivot.y or 0)` |

If scene object overrides `anchor.x/y` (look in `props`), use override not default.

---

## Width / height — when patchable

Decision table:

| Node state | width / height patch |
|------------|---------------------|
| `stretchAnchorX > 0` | ❌ — engine overwrites width |
| `stretchAnchorY > 0` | ❌ — engine overwrites height |
| `LayoutGroup` with `dynamicSize: true` AND `orientation === 'Horizontal'` | ❌ for width (auto from children) |
| `LayoutGroup` with `dynamicSize: true` AND `orientation === 'Vertical'` | ❌ for height (auto from children) |
| Child of LayoutGroup with `sizeModeH === 'both'/'stretch'/'shrink'` | ❌ for width |
| Child of LayoutGroup with `sizeModeV === 'both'/'stretch'/'shrink'` | ❌ for height |
| Otherwise | ✓ — direct write OK (especially `SizedContainer`, `NineSlicePlane`) |

---

## Scale

Texture base size required.

```
texBase = textureBaseWidthFromAtlas(scene.props.image)
scale.x = figma.width  / texBase.width
scale.y = figma.height / texBase.height
```

Texture base lookup sources (in order):
1. `assets-preloader/main/delayed.json` — has atlas frame sizes
2. PNG header read of `assets/img/<image>.png`
3. Spritesheet JSON if `image` references atlas frame

Skip patch if texBase unknown — flag for user.

**Never patch `scale.x`/`scale.y` on Text-class nodes or any ancestor of a Text node.** See "Text" section.

---

## Rotation

```
sceneRotation = figma.rotation * Math.PI / 180
```

Figma reports degrees. Sign convention same as PixiJS (clockwise positive in screen space). Verify on first patch with visible rotated node.

---

## Tint / Color

Figma fill `{r, g, b, a}` floats 0..1. Thing-Editor `tint` is integer 0xRRGGBB.

```js
const r = Math.round(fill.color.r * 255);
const g = Math.round(fill.color.g * 255);
const b = Math.round(fill.color.b * 255);
const tint = (r << 16) | (g << 8) | b;
```

`backgroundColor` (Scene root) same encoding.

White (no tint) = `0xFFFFFF` = `16777215`. Skip writing if Figma fill missing — don't blank-out an existing tint.

---

## Alpha / Opacity

Figma `opacity` 0..1 → Thing-Editor `alpha` 0..1. 1:1.

Plus per-fill alpha: combine if both present: `alpha = node.opacity * fill.color.a`.

---

## Visibility

Figma `visible: false` → scene `visible: false`. 1:1.

---

## Text

```
scene.props.text             <- figma.characters
scene.props.style.fontSize   <- figma.style.fontSize
scene.props.style.fill       <- rgbToHex(figma.fills[0].color)
scene.props.style.fontFamily <- figma.style.fontFamily   // map to project font
```

### Text x/y position sync — full engine model

Thing-Editor Text uses **two independent mechanisms** that both affect visual position:

1. **`anchor`** — set by `_refreshAnchor` from `style.align` / `verticalAlign`:
   ```
   alignValues = { center: 0.5, left: 0.0, right: 1.0, top: 0.0, bottom: 1.0 }
   text.anchor.x = alignValues[style.align]
   text.anchor.y = alignValues[verticalAlign]
   ```
   anchor controls where the texture is rendered relative to local origin.

2. **`pivot`** — when `canOverridePivotAndAnchor: true`, set by `recalculateCoordinates`:
   ```
   pivot.x = text.width  * normPivotX
   pivot.y = text.height * normPivotY
   ```
   When `canOverridePivotAndAnchor: false`, pivot stays at whatever the JSON sets.

**Visual position formula (scale=1, no rotation):**
```
visual_center_x = position.x + (0.5 - anchor.x) * textWidth  - pivot.x
visual_top_y    = position.y + (0   - anchor.y) * textHeight - pivot.y
```

**Standard combinations and Figma target:**

| style.align | normPivotX | anchor.x | pivot.x | scene.x means | Figma target |
|------------|-----------|----------|---------|---------------|--------------|
| 'center' | 0 | 0.5 | 0 | **center** of text | `figma_left + figma_width / 2` ✓ reliable |
| 'left' | 0 | 0.0 | 0 | **left edge** | `figma_left` ✓ reliable |
| 'right' | 0 | 1.0 | 0 | **right edge** | `figma_right` ✓ reliable |

| verticalAlign | normPivotY | anchor.y | pivot.y | scene.y means | Figma target |
|--------------|-----------|----------|---------|---------------|--------------|
| 'top' | 0 | 0.0 | 0 | **top edge** | `figma_top` ✓ reliable |
| 'center' | 0 | 0.5 | 0 | **center** | `figma_top + pixi_height / 2` ⚠️ |
| 'bottom' | 0 | 1.0 | 0 | **bottom edge** | `figma_bottom` ✓ reliable |

**⚠️ center Y caveat:** `pixi_height` ≠ `figma_text_height`. Figma shows tight glyph bbox; PixiJS uses full line metrics with ascenders/descenders. Cannot compute reliably without running engine. Skip y patch, verify visually.

**Non-standard normPivot (≠ 0) shifts the reference point:**
```
extra_shift_x = -normPivotX * textWidth
extra_shift_y = -normPivotY * textHeight
```
Flag ⚠️ if normPivotX or normPivotY ≠ 0 and style.align/verticalAlign is not default.

**Always read `style.align` and `verticalAlign` from scene props before computing. Defaults: both `'center'`.**

**Never patch `scale.x` / `scale.y` on Text-class nodes.** Text renders to a rasterized canvas at fontSize resolution. Scaling resamples that bitmap → blurry, pixelated edges. If Figma frame is bigger/smaller than current text bbox, adjust `style.fontSize` instead:

```
newFontSize = Math.round(currentFontSize * (figma.height / current.height))
```

**Rule extends to ALL ancestors.** PixiJS world transform = product of every ancestor's scale. A Container with `scale.x = 1.2` makes every Text child render at 1.2× → blur. Therefore:

- Before patching `scale` on any node N, walk N's subtree.
- If any descendant has class in text skip-list → REFUSE the scale patch on N.
- Instead split the work:
  1. Keep N.scale at 1.
  2. For each non-text descendant, patch its individual `scale` (sprites OK to scale).
  3. For each Text descendant, patch `style.fontSize` proportionally.
  4. Patch child `x`/`y` to compensate for the absent parent scale (multiply each child's local position by the would-be parent scale).

Skip-list classes for scale patches (self OR any descendant):
- `Text`
- `BitmapText` (still avoid — defeats glyph atlas alignment)
- `HTMLText`
- Any subclass containing `Text` in name

---

## Image / Texture

Figma image fill has `imageRef` (hash). Map to project texture by:
1. Checking exported asset name in Figma plugin sidecar (Code Connect)
2. Compare hash against `assets/img/*.png` content hashes
3. Fall back: ask user

If `image` prop already set and Figma ref matches the same exported file, skip.

---

## Patcher refuse matrix (cheat sheet for `apply-patch.mjs`)

The walker annotates each node with these flags (see `_resize` field below). Patcher refuses based on:

| Patched prop | Refuse condition | Suggested replacement |
|--------------|------------------|----------------------|
| `x`, `y` | parent class ∈ {LayoutGroup, LayoutGrid, Resizer} | change `parent.spacingX/Y`/`paddingLeft/...`/`aligmentX/Y` |
| `x` | `canOverridePivotAndAnchor: true` | `normalizePosX` or `normAnchorX` |
| `y` | `canOverridePivotAndAnchor: true` | `normalizePosY` or `normAnchorY` |
| `pivot.x` | `canOverridePivotAndAnchor: true` | `normPivotX` |
| `pivot.y` | `canOverridePivotAndAnchor: true` | `normPivotY` |
| `width` | `stretchAnchorX > 0` | `stretchAnchorX`, `marginLeft`, `marginRight` |
| `height` | `stretchAnchorY > 0` | `stretchAnchorY`, `marginTop`, `marginBottom` |
| `width` | self is `LayoutGroup` with `dynamicSize: true` & `orientation: 'Horizontal'` | change children or padding |
| `height` | self is `LayoutGroup` with `dynamicSize: true` & `orientation: 'Vertical'` | change children or padding |
| `width` | child of `LayoutGroup` with `sizeModeH ∈ {both, stretch, shrink}` | adjust parent sizeMode |
| `height` | child of `LayoutGroup` with `sizeModeV ∈ {both, stretch, shrink}` | adjust parent sizeMode |
| `scale.x/y` | self OR descendant is Text-class | patch `style.fontSize` |

Walker emits `_resize` block on each node:
```
_resize: {
  canOverride: bool,            // canOverridePivotAndAnchor
  useWorld: bool,
  stretchAnchorX: number,       // 0..1
  stretchAnchorY: number,
  parentClass: string|null,
  parentIsLayoutManaged: bool,  // class ∈ {LayoutGroup, LayoutGrid, Resizer}
  parentSizeModeH: string,      // 'none'|'both'|'stretch'|'shrink'
  parentSizeModeV: string,
  selfIsLayoutGroup: bool,
  selfDynamicSize: bool,
  selfOrientation: 'Horizontal'|'Vertical'|null
}
```

---

## Skipping rules

Don't patch if:
- delta below threshold (`|Δx| < 1px`, `|Δscale| < 0.01`, `|Δrot| < 1°`)
- target prop is computed at runtime by component (check `init()` body via grep)
- Figma node hidden + scene already hidden
- Class mismatch (Figma is text, scene is sprite — needs human)

---

## Worked example — sprite under static parent

Figma:
```
Frame "main" at (0, 0) 1920×1080
  └── Image "logo" at (860, 100) 200×200
```

Scene `assets/main.s.json`:
```json
{ "c": "Main", "p": { "name": "main" }, ":": [
  { "c": "DSprite", "p": { "name": "logo", "image": "logo", "x": 950, "y": 195 } }
]}
```

DSprite anchor 0.5 → expected `x = 860 + 200/2 = 960`, `y = 100 + 200/2 = 200`.

Patch:
```json
[
  { "scenePath": [":", 0], "prop": "x", "to": 960 },
  { "scenePath": [":", 0], "prop": "y", "to": 200 }
]
```

## Worked example — node under canOverridePivotAndAnchor + useWorld

Scene node (header back button shadow panel):
```json
{
  "p": {
    "canOverridePivotAndAnchor": true,
    "useWorld": true,
    "normAnchorX": 0,    "normAnchorY": 0,
    "normPivotX": 0,     "normPivotY": 0,
    "normalizePosX": 24, "normalizePosY": 18,
    "width": 64, "height": 64
  }
}
```

Figma target: shift the panel right by 4px (from x=24 to x=28).

❌ Wrong: `{ "prop": "x", "to": 28 }` — engine sets `position.x = game.W × 0 + 24 = 24` regardless.
✓ Right: `{ "prop": "normalizePosX", "to": 28 }`.

## Worked example — LayoutGroup gap fix

Scene `group` with two child sections:
```json
{
  "c": "LayoutGroup",
  "p": { "spacingX": 168, "paddingLeft": 0, "paddingRight": 0 },
  ":": [ { "c": "LayoutGroup", "p": { "name": "colorSection", "width": 628 } },
         { "c": "LayoutGroup", "p": { "name": "betSection",   "width": 716 } } ]
}
```

Figma: gap between sections = 164. Patch the **parent** spacing:
```json
[ { "scenePath": [":", 0], "prop": "spacingX", "to": 164 } ]
```

Trying to patch `colorSection.x` or `betSection.x` is futile — `layoutChildren()` rewrites them every frame.
