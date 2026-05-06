# Coord / Color / Rotation Mapping — Figma → Thing-Editor

## Coordinate origin

| System | Origin | Y axis |
|---|---|---|
| Figma node `absoluteBoundingBox` | top-left of canvas | down+ |
| Thing-Editor scene | parent-local | down+ |
| Thing-Editor stage | (0,0) at top-left of `game.W × game.H` | down+ |

Both Y down. Sign agrees. Only origin differs.

## Translate Figma → scene-local

For each Figma node N with parent chain P0..Pk down to the matched root frame:

```
sceneX = N.absoluteBoundingBox.x - rootFrame.x
sceneY = N.absoluteBoundingBox.y - rootFrame.y
```

Then walk down scene tree subtracting any container offsets that don't have a Figma counterpart (rare — usually scene mirrors Figma 1:1).

## Figma bounding box — critical rule

**Figma always reports the TOP-LEFT corner** of a node's bounding box via `absoluteBoundingBox` and `locationRelativeToParent`. This applies to frames, groups, instances, and autolayout frames — regardless of their content or anchor.

For autolayout frames with `sizing: hug`: the bbox wraps all children tightly. The top-left of the bbox is the top-left of the outermost visible content.

## Anchor adjust (sprite-likes)

Thing-Editor stores sprite position as the anchor point in parent space. Figma stores top-left of bounding box.

| Class | Default anchor | Convert |
|---|---|---|
| `Container` | n/a (no anchor) | `x = figma.x; y = figma.y` |
| `Sprite` | (0, 0) | `x = figma.x; y = figma.y` |
| `DSprite` | (0.5, 0.5) | `x = figma.x + figma.width/2; y = figma.y + figma.height/2` |
| `MovieClip` | (0.5, 0.5) | same as DSprite |
| `Text` | configurable via `anchor.x/y` prop. Default 0. | `x = figma.x + figma.width * anchor.x; y = figma.y + figma.height * anchor.y` |
| `NineSlicePlane` | (0, 0) | `x = figma.x; y = figma.y` |
| `Shape` | (0, 0) but draws around `pivot` | `x = figma.x + (pivot.x or 0); y = figma.y + (pivot.y or 0)` |

If scene object overrides `anchor.x/y` (look in `props`), use override not default.

## Prefab instance placement from Figma frame

When a scene node is a prefab instance (`"r": "prefabName"`) with `normPivotX/Y` set, the pivot offset from the card's visual top-left is `pivot.x` and `pivot.y` (already resolved from normPivotX/Y × card dimensions).

**Formula — Figma frame top-left → scene position:**

```
// parent_origin = parent container's top-left in world coords
// figma_tl      = Figma frame absoluteBoundingBox top-left in world

scene_x = figma_tl.x − parent_origin.x + pivot.x
scene_y = figma_tl.y − parent_origin.y + pivot.y
```

**Verification (reverse):**
```
card_visual_tl_world.x = parent_origin.x + scene_x − pivot.x   // must equal figma_tl.x
card_visual_tl_world.y = parent_origin.y + scene_y − pivot.y   // must equal figma_tl.y
```

**Important:** X and Y are independent. If X is already visually correct, only compute and patch Y. Do not recalculate X unless it is confirmed wrong.

**Worked example (MatchmakingScreen players):**
- players container origin in world: (160, 490)
- Figma left player frame top-left: (454, 340), pivot: (48.3, 59.7)
- `scene_x = 454 − 160 + 48.3 = 342` ← but user confirmed x=461 is visually correct; skip x
- `scene_y = 340 − 490 + 59.7 = −90` ← y was wrong (was 50), fix to −90

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

## Rotation

```
sceneRotation = figma.rotation * Math.PI / 180
```

Figma reports degrees. Sign convention same as PixiJS (clockwise positive in screen space). Verify on first patch with visible rotated node.

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

## Alpha / Opacity

Figma `opacity` 0..1 → Thing-Editor `alpha` 0..1. 1:1.

Plus per-fill alpha: combine if both present: `alpha = node.opacity * fill.color.a`.

## Visibility

Figma `visible: false` → scene `visible: false`. 1:1.

## Text

```
scene.props.text           <- figma.characters
scene.props.style.fontSize <- figma.style.fontSize
scene.props.style.fill     <- rgbToHex(figma.fills[0].color)
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

2. **`pivot`** — set by `recalculateCoordinates`:
   ```
   pivot.x = text.width  * normPivotX
   pivot.y = text.height * normPivotY
   ```
   pivot shifts the transform origin (what point `position` places in parent space).

**Visual position formula (scale=1, no rotation):**
```
visual_ref_x = position.x - pivot.x   // anchor.x=0.5 → ref is center; anchor.x=0 → ref is left
visual_ref_y = position.y - pivot.y   // anchor.y=0.5 → ref is center; anchor.y=0 → ref is top
```

More precisely:
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

Pseudocode for patch validation:

```js
function isScalePatchSafe(node, sceneMap) {
  const TEXT_CLASSES = /Text|BitmapText|HTMLText/;
  function hasTextDescendant(n) {
    if (TEXT_CLASSES.test(n.class || '')) return true;
    return (n[':'] || []).some(child => hasTextDescendant(resolveChild(child, sceneMap)));
  }
  return !hasTextDescendant(node);
}
```

Walker should annotate each entry with `hasTextDescendant: bool` so the diff stage can validate cheaply. Patcher rejects any scale entry where target node's `hasTextDescendant === true` and emits the split-patch suggestion.

## Image / Texture

Figma image fill has `imageRef` (hash). Map to project texture by:
1. Checking exported asset name in Figma plugin sidecar (Code Connect)
2. Compare hash against `assets/img/*.png` content hashes
3. Fall back: ask user

If `image` prop already set and Figma ref matches the same exported file, skip.

## Skipping rules

Don't patch if:
- delta below threshold (`|Δx| < 1px`, `|Δscale| < 0.01`, `|Δrot| < 1°`)
- target prop is computed at runtime by component (check `init()` body via grep)
- Figma node hidden + scene already hidden
- Class mismatch (Figma is text, scene is sprite — needs human)

## Worked example

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

Apply: DSprite anchor 0.5 → expected `x = 860 + 200/2 = 960`, `y = 100 + 200/2 = 200`.

Diff:
```
logo.x: 950 → 960 (+10)
logo.y: 195 → 200 (+5)
```

Patch entries:
```json
[
  { "scenePath": [":", 0], "prop": "x", "to": 960 },
  { "scenePath": [":", 0], "prop": "y", "to": 200 }
]
```
