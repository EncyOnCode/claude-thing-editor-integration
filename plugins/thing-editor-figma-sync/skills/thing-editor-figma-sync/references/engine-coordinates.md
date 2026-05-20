# Thing-Editor — Engine Coordinate Model (deep reference)

Goal: explain exactly how a screen positions its objects so a Figma diff stops being guesswork. Read this **before** computing any non-trivial offset.

## 1. Stage hierarchy

```
PIXI.Application.stage  (root canvas)
└── game.stage          (Container, name="stage")
    ├── currentScene    (Scene extends Container)
    │   ├── ...children — your screens, prefabs, UI nodes
    │   └── ...
    └── modals[]
```

- `game.W` × `game.H` = logical viewport (e.g. 1920×1080). Independent of physical canvas size; renderer resolution scales to fit the window.
- `game.stage` may be rotated 90° (`stage.rotation = π/2`) on portrait-locked devices; assume landscape unless project is portrait-only. With rotation applied, `stage.x = game.H` so children at scene-local `(0,0)` still appear top-left.
- A Scene is just a Container with `backgroundColor`, lifecycle hooks, and a `.all` shortcut map. Position math inside it is identical to any container.

## 2. Coordinate spaces

| Space | Origin | Where it lives |
|---|---|---|
| **Figma absolute** | top-left of canvas | `node.absoluteBoundingBox` / `locationRelativeToParent` (from root frame) |
| **World** (game logical) | top-left of `game.W × game.H` | every `getGlobalPosition()` returns this (after stage offset) |
| **Container-local** | container's transform origin (= position − pivot, before scale) | what `child.x`, `child.y` store |

Diffing rule: convert Figma coordinates **down** through scene parent chain (subtracting each parent's effective origin) until you reach the parent that owns the node you're patching.

## 3. The `resize-attrib` system

This is the **only** code path that derives scene `x/y/pivot/width/height` from declarative props. Everything in `recalculateCoordinates(container)` (in `engine/utils/resize-attrib.ts`) runs on:

- `addChild` (every newly attached container)
- `Container._onRenderResize()` (engine-driven, on `stage-will-resize`)
- Editor: every `afterPropertyChanged` event (40 ms throttle)

### 3.1 The killer flag: `canOverridePivotAndAnchor`

```ts
if (!container.canOverridePivotAndAnchor) return;
```

**If `false` (default), recalculateCoordinates does nothing.** Saved `x`, `y`, `pivot.x`, `pivot.y` are kept verbatim. None of the `norm*` props matter.

**If `true`**, every `norm*` prop is read and the saved `x/y/pivot.x/pivot.y` are **overwritten on every recalc**. So patching the saved value alone is useless when this flag is on — you must patch the corresponding `norm*` instead.

When diffing, the **first thing to check** on the target node is `canOverridePivotAndAnchor`. It dictates which props the patch must touch:

| Flag | Patch this | Don't bother patching |
|---|---|---|
| `false` (default) | `x`, `y`, `pivot.x`, `pivot.y`, `width`, `height` | `norm*` (engine ignores them) |
| `true` | `normAnchorX/Y`, `normalizePosX/Y`, `normPivotX/Y`, `stretchAnchorX/Y`, `useWorld` | `x`, `y`, `pivot.x`, `pivot.y` (will be overwritten) |

### 3.2 General formula (for `canOverridePivotAndAnchor = true`)

```
parentW = useWorld ? game.W : (effectiveParent.width ?? -1)
parentH = useWorld ? game.H : (effectiveParent.height ?? -1)

position.x = parentW * normAnchorX + normalizePosX  (+ stretch margin offsets)
position.y = parentH * normAnchorY + normalizePosY  (+ stretch margin offsets)

pivot.x    = container.width  * normPivotX
pivot.y    = container.height * normPivotY
```

Defaults (only when `canOverridePivotAndAnchor=true`): `normPivotX/Y = 0.5`, `normAnchorX/Y = 0.5`, `normalizePosX/Y = 0`, `stretchAnchorX/Y = 0`. If a key is **missing** in the JSON, the engine uses these.

### 3.3 Effective parent resolution

`recalculateCoordinates` does not always use `container.parent` directly:

| Flag (on the child) | Effective parent |
|---|---|
| `useWorld: true` | dimensions from `game.W/H`, position computation uses world space |
| `useTextCoordinate: true` (parent is Text) | `container.parent` (Text), with alignment offset added (compensates anchor) |
| `findNearestParent: true` | walks up `parent.parent...` until it finds a `Shape` or `SizedContainer`; uses that |
| (none) | `container.parent` directly |

`useGameRootPosition: true` is a separate path: after computing `targetX/Y` it converts through `getRootContainer().toGlobal()` then `parent.toLocal()` — useful for objects that should keep an absolute world spot regardless of nested transforms.

### 3.4 Stretching

If `stretchAnchorX > 0` (or Y), the container is **resized**: `container.width = parentW * stretchAnchorX − marginLeft − marginRight`. Skipped for `Text` (Text uses its own `maxWidth` flow). Margin offsets shift the center accordingly.

A garbage value like `width: 222533` on a header prefab ref is a tell-tale runaway: the editor wrote stretchAnchor or some scale prop that compounded the width across many recalc passes. Reset to a sane number and re-save.

### 3.5 Sprite-specific path with `fit` + `stretchAnchor`

`tryRecalculateSprite` runs only when **all** are true:

- container is `Sprite`
- `stretchAnchorX > 0` or `stretchAnchorY > 0`
- parent dimensions resolved
- sprite has a texture

It applies CSS-like `fit`: `stretch | contain | cover | none`. If `fit='none'` → falls back to general path (no auto-resize). With `contain`/`cover`, computes a uniform scale so the texture fits or fills the parent rect, then offsets the position to center the result inside the stretched area.

Otherwise the general formula at §3.2 runs.

## 4. The pivot trap (Sprite vs SizedContainer vs Text)

The same `pivot.x = container.width × normPivotX` line behaves differently per class because **`container.width` returns different things**.

### 4.1 `Container` / `Sprite` (default Pixi getter)

`Container.width` getter = `bounds.width × scale.x` = **displayed (post-scale) width**.

But `pivot` is applied in **local pre-scale space**. World transform of a local point `p`:

```
worldX = position.x + (p.x − pivot.x) * scale.x
```

So setting `pivot.x = displayedWidth × n` puts the pivot at local x = `textureWidth × scale × n`. Plugging visual extents:

- visual_left_world  = position.x − textureW · scale² · n
- visual_right_world = position.x + textureW · scale · (1 − scale · n)
- visual_width       = textureW · scale ✓

**Position lands at fraction `scale · normPivot` from visual left.**

| scale | normPivotX | position is at |
|---|---|---|
| 1.0 | 0.0 | left edge |
| 1.0 | 0.5 | center ✓ |
| 1.0 | 1.0 | right edge |
| 0.5 | 0.5 | 25% from left ⚠️ |
| 0.5 | 1.0 | center ⚠️ counter-intuitive |
| 0.5 | 0.0 | left edge |

For the matchmaking screen's `vsSprite` (`scale=0.5, normPivotX=normPivotY=1`) → position = visual center. That's why placing it at Figma's frame **center** works.

### 4.2 `SizedContainer`

`SizedContainer.width` getter is **overridden** to return raw `_width` (no scale multiplied). So `pivot.x = _width × normPivotX` lands at the intuitive fraction:

| normPivotX | position is at |
|---|---|
| 0.0 | left edge of the SizedContainer rect |
| 0.5 | center |
| 1.0 | right edge |

(Assuming `scale=1`, which is normal for SizedContainer.)

### 4.3 `Text` (dual mechanism)

Text has **two** independent shifts:

1. `text.anchor` set by `_refreshAnchor` from `style.align` and `verticalAlign`:
   ```
   alignValues = { center: 0.5, left: 0, right: 1, top: 0, bottom: 1, justify: 1 }
   anchor.x = alignValues[style.align]
   anchor.y = alignValues[verticalAlign]
   ```
   Defaults: `style.align='center'` → `anchor.x=0.5`; `verticalAlign='center'` → `anchor.y=0.5`.

2. `text.pivot` set by `recalculateCoordinates` from `container.width × normPivot`. Pixi Text's `width` is scaled bounds.

Combined visual position (no rotation):

```
visual_center_x = position.x + (0.5 − anchor.x) · textWidth − pivot.x
visual_top_y    = position.y + (0   − anchor.y) · textHeight − pivot.y
```

Standard table (`normPivotX = normPivotY = 0`, defaults overridden by setting them explicitly to 0):

| style.align | anchor.x | scene.x means | Figma target |
|---|---|---|---|
| center | 0.5 | text **center** | `figma_left + figma_w/2` ✓ |
| left | 0 | text **left edge** | `figma_left` ✓ |
| right | 1 | text **right edge** | `figma_right` ✓ |

| verticalAlign | anchor.y | scene.y means | Figma target |
|---|---|---|---|
| top | 0 | text **top edge** | `figma_top` ✓ reliable |
| center | 0.5 | text **center** | `figma_top + pixi_text_height/2` ⚠️ unreliable |
| bottom | 1 | text **bottom edge** | `figma_bottom` ✓ reliable |

⚠️ `pixi_text_height ≠ figma_text_height`. Pixi includes full font line-metrics (ascender + descender) while Figma reports the tight glyph bbox. So center-aligned Y can never be derived from Figma alone — either:
- (a) switch the node to `verticalAlign: 'top'` + `position.y = figma_top`, or
- (b) keep center-align and verify visually after applying.

Same for X with center align — but in practice `anchor.x=0.5` + `position.x = figma_center_x` matches exactly because Pixi text width tracks Figma text width along the inline axis (within sub-pixel tolerance).

`checkAlignBlur` (called automatically) snaps `anchor.x/y` to integer pixels (`Math.round(0.5*w)/w`) for centered text — keeps glyphs crisp on odd-width textures. Don't fight it; just know it's there.

**Never patch `scale.x/y` on Text.** Texture is rasterized at fontSize resolution; scaling resamples it → blur. Adjust `style.fontSize` instead.

**Never patch `scale.x/y` on any ancestor of a Text node either** — scale multiplies down the tree.

### 4.4 `DSprite`

`new DSprite()` calls `this.anchor.set(0.5)` in the constructor → texture is centered on (x, y) with no pivot magic. Used for game-side "things with motion" (`xSpeed/ySpeed/rSpeed` props). For coord mapping treat it as: `position = visual center`, regardless of `normPivot`.

### 4.5 `NineSlicePlane` / `NineSliceButton`

Has explicit `width`/`height` in the JSON (no scale, no auto-fit). Pixi's anchor is `(0,0)` (no offset). So:

```
visual_left   = position.x − pivot.x
visual_top    = position.y − pivot.y
visual_right  = visual_left + width
visual_bottom = visual_top  + height
```

To center the panel on a Figma rect: `pivot.x = width/2`, `pivot.y = height/2`, then `position = figma_center`.

### 4.6 `Shape`

Like `SizedContainer` (explicit `_width`/`_height`) but actually drawn (rect/circle/etc). `findNearestParent` chain stops at Shape too.

## 5. Resize lifecycle in detail

Recalc runs per container in this order:

1. Bail if `canOverridePivotAndAnchor=false`.
2. Resolve effective parent (text-coordinate / nearest-shape / direct).
3. **Text-only**: if `maxWidth` set + `stretchAnchorX>0`, derive maxWidth from parent dimensions; otherwise, if Text has standalone maxWidth, recompute from `parent.width × stretchAnchorX`.
4. Try sprite-fit path (§3.5). Returns early if applied.
5. General position formula (§3.2). Adds text-coordinate offset, stretch sizing, normalize-pos.
6. Set pivot from `container.width/height × normPivot`.

Order **matters** for SizedContainer ancestors: their `_width`/`_height` are explicit, so descendant pivot/anchor calc can rely on them. For pure `Container` parents (auto-bounds), child resizing can change parent bounds → parent pivot recalc on next pass. To avoid race, prefer `SizedContainer` whenever a layout-sensitive child reads parent width.

The editor throttles `recalculateCoordinatesForEveryOne` to 40 ms with one pending re-run, so large prop edits trigger at most ~25 fps of recompute. Game runtime calls it via `_onRenderResize` on the resize event only.

## 6. Going from Figma to scene props (the algorithm)

Given a Figma node N with `absoluteBoundingBox = { x, y, w, h }`:

1. **Pick the matching scene node** by name (or composite key per SKILL §4).
2. **Compute its parent chain origin in world** (sum of parent `position − pivot`, walked from scene root). This handles SizedContainer pivots.
3. **Read the node's class + flags**:
   - Class (DSprite, Sprite, Text, NineSlicePlane, SizedContainer, Container, …)
   - `canOverridePivotAndAnchor`
   - For Text: `style.align`, `verticalAlign`
   - `normPivotX/Y`, `normAnchorX/Y`, `normalizePosX/Y`, `stretchAnchorX/Y`, `useWorld`, `findNearestParent`
4. **Pick the target reference point** based on class + flags (use the lookup tables in §4):
   - Sprite/DSprite → visual center (or compute anchor offset)
   - SizedContainer → derived from `normPivot × _width`
   - Text → derived from `(0.5 − anchor.x) × w − pivot.x` etc.
   - NineSlicePlane → `position − pivot`
5. **Derive what value would land that reference on the Figma rect**:
   - If `canOverridePivotAndAnchor=false`: solve for `x/y` (and optionally `pivot`).
   - If `true`: solve for `normAnchorX/Y` and `normalizePosX/Y` so that `parentW * normAnchorX + normalizePosX = desiredPos`. If parent dimensions match world, prefer pure `normAnchor` (responsive); use `normalizePos` for hard offsets.
6. **Verify with reverse formula** before reporting.

Always show the parent-chain origin derivation and the formula in Part A of the report — nobody trusts a number that drops out of nowhere.

## 7. Common artifacts and how to spot them

| Symptom | Likely cause |
|---|---|
| Saved value wildly off (e.g. `x: 111266`) but `norm*` look sane | Editor stretchAnchor runaway. Reset saved x/y/pivot/width to expected static value; engine recomputes them anyway. |
| Object visible at runtime but invisible in editor (or vice versa) | `useWorld` only resolves at runtime if `game.W/H` known at editor time — they are, but if scene root not in `game.stage` (preview), differs. |
| Pixel-jitter / blur on centered Text | `checkAlignBlur` rounds anchor; ensure texture w/h are even, or accept sub-pixel rounding. |
| Child position correct in editor, wrong in build | Child recalcs after parent in editor (sequential), but at runtime `addChild` triggers child recalc before parent render — invert the order or set `useGameRootPosition`. |
| Pivot jumps when font / text content changes | `pivot.x = textWidth × normPivot`; textWidth changes with content. Use `normPivotX=0` + explicit `pivot.x=0` or set fixed pivot via direct `pivot.x` (and `canOverridePivotAndAnchor=false`) if you want stable anchoring. |
| Prefab placement looks fine in prefab but shifted in scene | Prefab instance has its own `normPivot/normAnchor` overrides; root container of prefab uses parent (scene) dims, while prefab internals use prefab-root dims. Walk both. |

## 8. Gotchas worth memorizing

- **`canOverridePivotAndAnchor` is the master switch.** Forget it and patches do nothing.
- **`SizedContainer.width` is raw, `Sprite.width` is scaled.** Pivot math diverges accordingly.
- **`scale × normPivot` of a Sprite** lands position at that fraction of visual width, NOT at `normPivot` of visual.
- **Default `normPivot/normAnchor = 0.5`** — JSON omitting these means center, not zero.
- **Text uses anchor AND pivot**; position semantics depend on both.
- **`verticalAlign='center'` Y** is unreliable from Figma (Pixi line height ≠ glyph bbox).
- **Never scale Text** or any ancestor of Text.
- **`useWorld` overrides parent dimensions** with `game.W/H` — handy for screen-spanning UI; useless for nested layout.
- **`findNearestParent`** climbs up to Shape/SizedContainer — important when intermediate plain Containers exist between sized regions.
- **Stage rotation** in portrait builds — your scene-local (0,0) still maps to top-left visually, but raw mouse coords differ. Mostly invisible to layout math.

## 9. Reference for the matchmaking screen specifically

Confirmed origin chain (all in world coords, derived from `screen` at `(960,540)` pivot `(960,540)`):

| Container | local pos | local pivot | parent | origin world |
|---|---|---|---|---|
| `screen` (SizedContainer 1920×1080) | (960, 540) | (960, 540) | scene root | (0, 0) |
| `content` (SizedContainer h=1080) | (960, 540) | (50, 540) | screen | (910, 0) |
| `players` (SizedContainer w=1600) | (960, 540) | (800, 50) | screen | (160, 490) |
| `bet` (SizedContainer 1080×28) | (73, 246) | (540, 14) | content | (910 + 73 − 540, 0 + 246 − 14) = (443, 232) |

Card prefab (`matchmakingPlayerCard`): Figma frame `322×400` (auto-layout column hug: avatar 300 + gap 24 + name 322×76, alignItems=center). Pivot when `normPivotX/Y=0.15` resolves to `(48.3, 60)`.

Cancel button: Figma `546×96` at `(687, 912)`. With `pivot=(width/2, height/2)=(273, 48)`, `position=figma_center=(960, 960)`. `normAnchorY = 960/1080 = 0.8889`.

VS sprite: `texture vs.png` (assumed 397×249), `scale = 229.55/397 = 0.578`. With `normPivotX=normPivotY=1` + scale=0.578, position lands at visual center — `normAnchorX = 956.275/1920 = 0.498`, `normAnchorY = 493.485/1080 = 0.4569`.

`searchingPlayer` Text: `style.align='center'` (default) + `verticalAlign='top'` (set explicitly) → position = (text-center-x, text-top-y). Figma `404×34` at `(757.5, 132)` → in content space `(959.5−910, 132) = (49.5, 132)`. Saved `(50, 132)` ✓.

These numbers reconcile to within 1 px of Figma everywhere except center-aligned Y values, which require visual confirmation.

## See also

- **Per-class `@editable` field reference**: companion plugin `thing-editor-deep/references/03-components.md` — complete catalogue of every built-in component class with editable fields, defaults, gotchas.
- **NodeExtendData (editor-only metadata, NOT serialized)**: `thing-editor-deep/references/08-types.md` — 61 fields including `isPrefabReference`, `serializationCache`, `__isPreviewMode`.
- **Pivot trap + DSprite 0.5 anchor + ScrollLayer single-drag**: `thing-editor-deep/references/10-gotchas.md` — exhaustive list of 200 non-obvious behaviors.
- **Build pipeline (ifdef, vite, electron)**: `thing-editor-deep/references/07-build.md` — for understanding why prod uses jsDelivr CDN and dev uses local pixi.
- **MovieClip timeline JSON schema**: `thing-editor-deep/references/05-animation.md` — full TimelineSerializedData + FieldPlayer easing equations.
