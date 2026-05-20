# Component catalog (every built-in class)

Path: `thing-editor/src/engine/lib/assets/src/`

## Inheritance graph

```
PIXI.Container (prototype-extended at engine/lib/assets/src/basic/container.c.ts)
├── Scene                          basic/scene.c.ts (45-65)
├── ParticleContainer              basic/particle-container.c.ts (7-25)
├── ParticleSystem                 basic/particle-system.c.ts (48-869)
├── Spawner                        basic/spawner.c.ts (10-110)
├── SizedContainer                 extended/sized-container.c.ts (12-90)
│   └── UniversalButton            extended/universal-button.c.ts
├── ScrollLayer                    extended/scroll-layer.c.ts (25-460)
│   └── HTMLOverlay                extended/html-overlay.c.ts (18-249)
├── Trigger                        extended/trigger.c.ts (22-377)
├── OrientationTrigger             mobile/orientation-trigger.c.ts (13-405)
│   ├── IsMobileTrigger            extended/is-mobile-trigger.c.ts (5-25)
│   └── OrientationParentResizer   common/orientation-parent-resizer.c.ts (4-10)
├── LayeredContainer               extended/layered-container.c.ts (9-139)
├── LayeredContainerPortal         extended/layered-contaiter-portal.c.ts (31-236)
├── Mask                           extended/mask.c.ts (7-95)

PIXI.Sprite
├── DSprite                        basic/d-sprite.c.ts (4-35)
│   ├── Button                     basic/button.c.ts (20-220)
│   └── MovieClip                  basic/movie-clip.c.ts (30-579) implements IGoToLabelConsumer
│       └── BackgroundImage        extended/background-image.c.ts (21-200)

PIXI.Graphics
└── Shape                          basic/shape.c.ts (48-160)
    ├── ShapeButton                basic/shape-button.c.ts (12-190)
    │   ├── Checkbox               basic/checkbox.c.ts (10-310)
    │   ├── Toggle                 basic/toggle.c.ts (12-240)
    │   └── RadioButton            basic/radio-button.c.ts (8-90)
    ├── ShapeGradient              extended/shape-gradient.c.ts (20-124)
    ├── ProgressBar (composition)  extended/progress-bar.c.ts (37-285)
    ├── ScrollBar                  extended/scroll-bar.c.ts (34-670)
    └── Resizer                    extended/resizer.c.ts (19-193)
        └── ParentResizer          common/parent-resizer.c.ts

PIXI.Mesh
├── Fill                           basic/fill.c.ts (73-180)
└── Rope                           basic/rope.c.ts (9-140)
    └── Trail (subclass)

PIXI_NineSlicePlane → NineSlicePlane  basic/nine-slice-plane.c.ts (7-194)
PIXI.Text → Label (prototype + class) extended/label.c.ts (10-201)
PIXI.Spine (pixi-spine) → Spine     extended/spine.c.ts (200-1430)

custom/
├── LoadingView (DEPRECATED)       custom/loading-view.c.ts (9-90)
└── ParticleShort                  custom/particle-short.c.ts (6-50)

___system/
├── Scene-Linked-Promise (Container) ___system/scene-linked-promise.c.ts (40-346)
└── Delay (Container)              ___system/delay.c.ts (37-110)
```

## Scene (basic/scene.c.ts)

```
@editable backgroundColor: number = 0 (color)
@editable isStatic: boolean = false
@editable faderType: string|null = null (prefab, filterAssets)
```
- `init()` L45-49: `_refreshAllObjectRefs()`, sets `game._currentScene = this`
- `_refreshAllObjectRefs()` L51-65: builds `this.all` map by traversing children, syncs `game.all`
- Virtual hooks: `onShow()`, `onMouseDown/Up/Move()`, `onHide()` (L25-38)
- L76-78: `remove()` throws — use `game.closeCurrentScene()`
- L80-82: `__canAcceptParent` returns false
- EDITOR: `all` is `ACCESS__ALL_ASSERTING_PROXY`

## Container prototype extensions (basic/container.c.ts)

Added to PIXI.Container.prototype:
- `getGlobalRotation()` L21
- `getScenePosition()` L31
- `getRootContainer()` L35
- `detachFromParent()` L43
- `init()` L49-55: clears editor flags, schedules RAF `_onRenderResize`
- `onRemove()` L57-62: clears editor state, asserts not in editor mode
- `remove()` L64-66: `Lib.destroyObjectAndChildren(this, true)` (uses RemoveHolder)
- `removeWithoutHolder()` L73
- `findParentByType<T>()` L77
- `findChildByName()` (returns `getChildByName` from PIXI)
- `findChildrenByType<T>()`
- `addFilter()` L94

## DSprite (basic/d-sprite.c.ts)

```
@editable xSpeed: number  (step:0.001, animate:true)
@editable ySpeed: number  (step:0.001, animate:true)
@editable rSpeed: number  (step:0.001, animate:true)
```
- Constructor: `anchor.set(0.5, 0.5)` — CRITICAL default
- `update()` L23: applies velocities (`x += xSpeed`, `y += ySpeed`, `rotation += rSpeed`)
- `angleBySpeed()` L19: sets rotation from atan2(ySpeed, xSpeed)
- Simplest moving sprite base

## MovieClip (basic/movie-clip.c.ts)

Extends DSprite, implements IGoToLabelConsumer.
```
@editable timeline: TimelineSerializedData (type:'timeline', important, visible: !isPrefabReference)
@editable isPlaying: boolean = true
@editable delay: number = 0  (min:0)
```
See `references/05-animation.md` for full timeline mechanics.

## Button (basic/button.c.ts)

Extends DSprite, implements IImageButton.
```
@editable interactive (override, disabled note)
@editable hoverImage/pressImage/disabledImage: image
@editable isScaleOnHover/isScaleOnClick: boolean
@editable disabledAlpha (0-1, visible if !disabledImage, default 0.76)
@editable enabled: boolean (important)
@editable onClick: callback[] (important)
@editable diTargets: string[]
@editable hotkey: number
@editable sndClick/sndOver: sound
@editable repeatDelay/repeatInterval (min:0)
```
- `init()` L96 attaches listeners (onDown/Up/Over/Out)
- Static state: `Button.overedButton`, `downedButton`, `clickedButton`
- `allActiveButtons` list maintained
- Scroll threshold prevents accidental clicks during ScrollLayer drag

## Shape (basic/shape.c.ts)

Extends PIXI.Graphics.
```
@editable shape: select RECT|ROUND_RECT|CIRCLE|ELLIPSE|POLY|CUSTOM_ROUND_RECT
@editable shapeRadius (visible if ROUND_RECT/CIRCLE)
@editable _shapePoints: ref[] (visible if POLY)
@editable shapeLineWidth/Color/Alpha/Alignment
@editable shapeFillColor/Alpha
@editable isItHitArea: boolean
```
- `init()` L91 draws
- `_drawThing()` L100: clear + lineStyle + beginFill + drawX + endFill
- `isItHitArea` hides shape rendering but applies as `parent.hitArea` on init

## ShapeButton (basic/shape-button.c.ts)

Extends Shape, implements IShapeButton. TickerTween-animated colors and scale.
```
@editable normalColor/hoverColor/pressColor/disabledColor (color)
@editable borderNormalColor/...
@editable normalAlpha/hoverAlpha/pressAlpha/disabledAlpha (0-1)
@editable isSmoothChangeColor: boolean
@editable smoothChangeColorDuration/Easing (visible if smooth)
@editable enabled: boolean
@editable clickRepeatDelay (default 0.1)
@editable stopPropagation: boolean
@editable altTargetPath: data-path
@editable onClick: callback[] (important)
@editable hotkey: number
@editable diTargets: string[]
@editable onOverCallback/onOutCallback: callback[]
@editable sndClick/sndOver: sound
@editable isScaleOnHover/OnClick: boolean
@editable scaleOnOverDuration/Factor/Easing
@editable scaleOnClickIn/OutDuration/Factor/Easing
```
- TickerTween for color/scale animations, lookup `Easing.*` by name

## Checkbox/Toggle/RadioButton

All extend ShapeButton.

**Checkbox** (`checkbox.c.ts`):
```
@editable isChecked: boolean (important)
@editable animationDuration, spriteScale
@editable onChecked/onUnchecked: callback[]
@editable activeImage/inactiveImage (image, afterEdited refresh)
@editable activeImageTint/inactiveImageTint/hoverImageTint (color)
@editable activeColor/inactiveColor/borderActiveColor/borderInactiveColor
```
- `checkSprite` is children[0] (DSprite)
- TickerTween for alpha/image transitions
- `__EDITOR_onCreate` auto-creates DSprite child; `__hideChildren = true`

**Toggle** (`toggle.c.ts`):
```
@editable isToggled (afterEdited refresh)
@editable startOffset/endOffset
@editable canUseAnimation/easing/duration
@editable backgroundPath/handlePath: data-path
@editable activeBackgroundColor/inactiveBackgroundColor
@editable activeAlpha/inactiveAlpha (0-1, step:0.1)
@editable handleActiveColor/handleInactiveColor
```
- Handle X interpolated between startOffset/endOffset
- `__EDITOR_onCreate` creates Shape background + handle

**RadioButton** (`radio-button.c.ts`):
```
@editable backgroundPath/handlePath: data-path
@editable isChecked: boolean
@editable alphaOnCheckDuration
@editable canUseAnimation: boolean
```
- Handle alpha fade via TickerTween

## UniversalButton (extended/universal-button.c.ts)

Extends SizedContainer.
```
@editable visualMode: select 'SHAPE'|'SPRITE' (important, afterEdited)
@editable targetChildPath: data-path
@editable [shape colors/border/alpha/animation]
@editable [sprite images]
@editable enabled (afterEdited)
@editable clickRepeatDelay, onClick: callback[] (important)
@editable hotkey, sndClick/sndOver
@editable [scale animations]
```
- Mode-dependent visibility via `isShapeMode/isSpriteMode` functions
- Static `allActiveUniversalButtons[]`, `downedByKeycodeButton`

## ParticleSystem (basic/particle-system.c.ts, 869 lines)

@pixi/particle-emitter wrapper with curve support.
Major @editable fields (lifetime, frequency, alpha, scale, color, speed, rotation, accel, path, spawn shape, textures, blendMode):

**Lifetime/Emission:**
- `lifeTimeMin/Max` (5/15), `frequency` (0.1), `spawnChance` (1), `particlesPerWave` (1)
- `emitterLifetime` (-1 infinite), `maxParticles` (-1), `isLocalPosition`, `addAtBack`

**Alpha:** Static (0.75) OR interpolated values OR `useCurve + alphaCurve`
**Scale:** Static OR interpolated OR curve, with `scaleIsStepped`, `scaleMinMult`
**Color:** Static (0xab6f9f) OR interpolated
**Speed:** Static (100-150) OR interpolated OR curve, optional `valueMoveSpeedMinMult`
**Rotation:** Static (0-360) OR interpolated with accel
**Acceleration:** Optional `moveAccelX/Y`, `moveAccelMinStart/MaxStart`, `moveAccelRotate`
**Path Movement:** Optional `movePath` string + speed curve/values + `pathMinMult`
**Texture:** Type selector — single/animatedSingle/textureRandom
**Spawn Shape:** type rect `{x,y,w,h}` OR torus `{radius, innerRadius, rotation, x, y}`
**Blend Mode:** PIXI.BLEND_MODES select

Methods: `play()`, `stop()`, `smoothStop()` (waits for particles to die)
`curveToList(curve)` L137-145: samples 20 points from Curve

Editor gizmo shows emission shape (rect or torus); `__onSelect/Unselect` toggles visibility.

## ParticleContainer (basic/particle-container.c.ts)

```
constructor: interactiveChildren=false, eventMode='none'
forAllChildren override (EDITOR-only iteration to skip runtime children)
```
Optimization container for many particles.

## Spawner (basic/spawner.c.ts)

```
@editable prefabToSpawn: prefab (important)
@editable enabled: boolean
@editable interval/intervalRandom (min:0)
@editable speed/speedRandom
@editable applyRotation: boolean
@editable container: data-path (validates Container)
```
- `spawn()` L98: `Lib.loadPrefab(prefabToSpawn)`, applies parent.toLocal for position
- `___containerID` caches container's `___id` for validation
- Speed applied as xSpeed/ySpeed on spawned DSprite

## Text (extended/label.c.ts + prototype extensions)

PIXI.Text extended:
- `translatableText` (getter/setter, calls L())
- `textTemplate` (parses embedded keys, registers via `L.registerTextGlobalRefs`)
- `IMAGE` property removed (returns undefined)

**Label** (label.c.ts):
```
@editable dataPath: data-path (important)
@editable refreshInterval (min:0, default 10)
@editable template: string multiline (disabled if translatableText)
@editable paramName: string default '%d' (disabled if !translatableText)
@editable isNumeric: boolean
@editable plusMinus: boolean (disabled if !isNumeric)
@editable counterSpeed (0.001-1, step:0.001, visible if isNumeric)
@editable decimalsCount (0-20, visible if isNumeric)
@editable onChanged/onCounter/onCounterFinish: callback
```
- `updateValue()` L91: `getValueByPath(dataPath)` + `customizeVal(val)` + onChanged
- `applyValue(val)` L130: stepTo if counterSpeed<1, format with plusMinus/decimals, L() if translatableText
- `__beforeSerialization` nulls template if translatableText set

## ProgressBar (extended/progress-bar.c.ts)

```
@editable height (min:0, default 200)
@editable dataPath: data-path (important)
@editable capMargin (min:0)
@editable refreshInterval (min:0)
@editable reverse, smooth, smoothStep
@editable min/max/step (step:0.00001)
@editable onFinish/onChanged/afterSlide: callback
@editable itemsCount (min:0)
@editable bar/cap: ref
```
- `bar`/`cap` found by `findChildByName('bar')`/`findChildByName('cap')`
- gotoLabelRecursive('progress-item-N') for milestone animations
- onDown allows interactive scrolling
- setValueByPath if dataPath on drag

## ScrollLayer (extended/scroll-layer.c.ts)

```
@editable interactive (override, default true)
@editable x/y (override, disabled with DISABLE_XY_TIP)
@editable visibleArea/fullArea: rect
@editable mouseHandler: data-path
@editable desktopInertia (0-0.99, default 0.8)
@editable mobileInertia (0-0.99, default 0.92)
@editable bouncingBounds: boolean default true
```

**CRITICAL static state L9:** `draggingLayer: ScrollLayer | null` — **only ONE can drag at a time**

- `onDown` starts drag (assigns to draggingLayer)
- `static updateGlobal` (L166-174) updates active dragging layer
- `update()` applies inertia each frame
- `applyLimit()` enforces bounds with stepTo
- `scrollTo(target, callback, instantly)` smooth scroll to Container
- `relativeScrollX/Y` getters (0-1 normalized)
- emits `'scroll-changed'` event

## ScrollBar (extended/scroll-bar.c.ts)

```
@editable scrollLayerPath: data-path
@editable scrollLayer: ref
@editable orientation: select VERTICAL|HORIZONTAL (important)
@editable trackPath/thumbPath: data-path
@editable track/thumb: ref
@editable minThumbSize (10-100, default 20)
@editable trackLength (50-1000, default 200)
@editable height (50-2000, override, visible: !useScrollLayerHeight)
@editable useScrollLayerHeight: boolean (important)
@editable visibilityMode: select ALWAYS|AUTO|NEVER|SCROLL_AVAILABLE
@editable autoHideDelay (100-5000, visible if AUTO)
```
- Document-level pointer listeners during drag (must cleanup in onRemove)
- Updates `ScrollLayer._virtualScrollY` directly (bypasses applyLimit)
- emits `'scrollbar-changed'`

## HTMLOverlay (extended/html-overlay.c.ts)

Extends ScrollLayer.
```
@editable innerHTML: string multiline
@editable jsScripts: string[] multiline
@editable handleScroll: boolean default true
@editable zIndexHTML: number default 10000
@editable className: string
@editable fadeSpeed (0.0001-1, default 0.2)
@editable bouncingBounds: forced false (visible: false)
```
- DOM div synced via `getDomBoundsFromPixi`
- `position: absolute` in EDITOR, `fixed` in runtime
- `_overlayInterval` runs every ~16ms checking visibility
- emits `'html-attached'` / `'html-will-remove'`
- className gets portrait-/landscape-/mobile-/desktop- suffixes

## Trigger (extended/trigger.c.ts)

```
@editable Centralize: btn (onClick centralizeObjectToContent)
@editable state: boolean (disabled if dataPath set)
@editable dataPath: data-path (important)
@editable invert: boolean
@editable pow (0.001-1, step:0.001, type:'pow-damp-preset')
@editable damp (0.001-0.999)
@editable alphaShift (-1 to 0, separator)
@editable scaleShift (min:-1, default 0)
@editable xShift, yShift
@editable isApplyInteractivity: boolean default true
@editable onEnable/onDisable: callback
@editable __keepVisibleInEditor (EDITOR-only)
```
- `q` (state 0=show, 1=hide), `qSpeed` damped
- `updatePhase()` L166: `qSpeed += (qTo-q)*pow; qSpeed *= damp; q += qSpeed`
- pow=1 instant
- Children stop updating when invisible (alpha ≤ 0.015 or scale ≤ 0.0015)
- `applyInstantly()` runtime-only
- Calls `_onDisableByTrigger` recursively on children

## OrientationTrigger (mobile/orientation-trigger.c.ts)

```
@editable onPortrait/onLandscape: callback (EDITOR)
@editable __callInEditorMode: boolean
@editable Centralize: btn
@editable landscapeX/Y/ScaleX/ScaleY/Alpha/R (disabled — propDisabler)
@editable portraitX/Y/ScaleX/ScaleY/Alpha/R (disabled)
```
- `IGNORE_DIRECT_PROPS` flag prevents recursion during serialization
- Direct x/y/rotation/scale setters update BOTH portrait + landscape values (unless IGNORE_DIRECT_PROPS)
- Setters in EDITOR delay callbacks 600ms
- `__beforeSerialization` zeros direct properties to store only variant-specific values

## Mask (extended/mask.c.ts)

```
@editable _enabled: boolean default true
@editable enabled (getter/setter)
```
- Mask child is first child or named 'mask'
- Toggles mask on/off, restores visibility state when disabled
- `__EDITOR_onCreate` creates default Shape mask
- Preview mode shows mask shape

## LayeredContainer + Portal (extended/layered-container.c.ts + layered-contaiter-portal.c.ts)

Render container's content elsewhere in tree via portal:
```
@editable targetContainer: data-path (getter/setter calls _updateTargetContainer)
@editable enabled: boolean default true
@editable rendererPortalContainer: ref (LayeredContainerPortal type)
@editable containerOwner: ref (on Portal)
```
- LayeredContainerPortal has custom hitArea proxying events back via `findTargetAt`
- `allPortalsContainers` static Set tracks all portals
- Portals sorted by Y depth each frame (`'updated'` event handler)
- Portal `__canAcceptParent` returns false

## NineSlicePlane (basic/nine-slice-plane.c.ts)

Extends PIXI_NineSlicePlane.
```
@editable pixelPerUnit (step:0.1)
@editable useOldBehaviour: boolean default true
```
- `useOldBehaviour=false`: scales positions by pixelPerUnit
- Editor sliceGizmo (Graphics) shows 9-slice grid in cyan

## ShapeGradient (extended/shape-gradient.c.ts)

Extends Shape.
```
@editable refreshGrid: btn (onClick _drawThing)
@editable gradientType: select LINEAR_HORIZONTAL|LINEAR_VERTICAL|RADIAL
@editable gradientColors: color[]
@editable gradientAlphas: number[]
```
- Static `textureCache: Map<string, Texture>` shared cache
- Renders gradient to canvas, creates Texture.from(canvas)
- Cache key includes colors, alphas, dimensions

## Fill (basic/fill.c.ts)

Extends Mesh with custom GLSL vertex/fragment shaders.
```
@editable verticesX/Y (2-30, important)
@editable xShift/yShift
@editable fillWidth (width control)
@editable xRepeat/yRepeat (wrapping)
```
- TEXTURE_WRAP_MODE requires power-of-two textures

## Rope (basic/rope.c.ts)

Extends Mesh, points array with widths.
```
@editable showGizmo: boolean (EDITOR)
@editable isVert: boolean
@editable segmentsAmount (min:2, step:1, default:2)
```
- RopeGeometry, autoUpdate per-render
- gizmoGraphics for point visualization in editor

## Resizer (extended/resizer.c.ts)

```
@editable x/y (override, disabled DISABLE_XY_TIP)
@editable visibleArea/fullArea: rect
@editable resizeX/resizeY (boolean, EDITOR-only, scales by game.W/game.H)
@editable relativeX/relativeY (boolean, controls xPos/yPos visibility)
@editable xPos/yPos (-1 to 1, step:0.01, visible if relative*)
@editable fixed (boolean, visible if any resize/relative active)
```
- Only useful for dynamicStageSize projects
- `recalculateSize()` uses parent.toLocal for game-coord conversion
- `__afterSerialization` deletes x/y/scale if managed

## ParentResizer (common/parent-resizer.c.ts)

Extends Resizer. `recalculateSize()` calls super then updates parent.width/height.

## OrientationParentResizer (common/orientation-parent-resizer.c.ts)

Extends OrientationTrigger. `applyOrientation()` checks parent.W (custom) vs width (Shape).

## SizedContainer (extended/sized-container.c.ts)

```
@editable width/height: number (important, override)
```
- Lightweight container with explicit width/height (vs Container that sizes to children)
- EDITOR: borderGizmo (Graphics) cyan 1px outline on selection

## BackgroundImage (extended/background-image.c.ts)

Extends MovieClip.
```
@editable frameUpdateInterval (min:0, step:1, default:10)
```
- Dynamically crops texture to screen size (reduces fill rate)
- Not recommended with position/scale/rotation animations

## IsMobileTrigger (extended/is-mobile-trigger.c.ts)

Extends OrientationTrigger.
- `getTriggerConditionState()` returns `game.isMobile.any`
- Disables orientation resize (`_onRenderResize` disabled L7)

## ___system

**SceneLinkedPromise** (`___system/scene-linked-promise.c.ts`) — see references/05-animation.md or details below.

**Delay** (`___system/delay.c.ts`):
```
@editable delay: number
@editable ___stack: debug ref (EDITOR-only)
```
- `static delay(callback, delayFrames, container)` factory L37-66
- `delayFrames <= 0` executes synchronously
- `skip()` forces immediate execution
- Pooled

**System prefabs JSON:**
- `fader/default` — default fader prefab
- `final-fader` — shown on `_reloadGame()` if exists
- `unknown-prefab` — placeholder brown rect "Unknown prefab reference"
- `backdrop` — debug grid (18 Shape lines, 100px spacing, alpha 0.2/0.4 primary)
- `gizmo` — transform gizmo (XY+Y+X axes + rotation)
- `guide` — fading layout guide (alpha 1→0 over 46 frames, then this.remove)
- `rect-guide` — outline rect for bounds (cyan 1px line, transparent fill)

## ParticleShort (custom/particle-short.c.ts)

Extends DSprite, quick fade+drift particle.
```
@editable duration (min:3)
@editable xSpeedFactor/ySpeedFactor (0.01-1, default 0.93)
```
- Random size init, auto-removes when alpha ≤ 0

## Custom button extensions seen in real games

Not in engine but commonly extended:
- HoldShapeButton, NineSliceButton, LinkDOMButton, GradientButton (in libs)
