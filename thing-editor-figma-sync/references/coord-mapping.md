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
scene.props.text       <- figma.characters
scene.props.style.fontSize <- figma.style.fontSize
scene.props.style.fill <- rgbToHex(figma.fills[0].color)
scene.props.style.fontFamily <- figma.style.fontFamily   // map to project font
```

**Text bbox lies.** Don't sync `x/y` from Figma text bbox — anchor + font baseline differ. Position text by parent layout, sync only style + content.

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
