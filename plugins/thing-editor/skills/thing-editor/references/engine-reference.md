# Thing-Editor Engine Reference

PixiJS v7.2.4 game engine (aliased to `node_modules/pixi.js/dist/pixi.mjs` via `vite.config.js`). JSON-driven scenes + TypeScript components. Editor runs in Electron; runtime is browser/Cordova.

---

## Class Hierarchy

```
Container (PixiJS)           ← base of everything
├── Scene                    ← scene root (scene.c.ts)
├── Sprite                   ← image display (sprite.c.ts) — has `image` property
│   └── DSprite              ← sprite + velocity (xSpeed, ySpeed, rSpeed, anchor 0.5 by default)
│       └── MovieClip        ← DSprite + timeline animation
├── Graphics
│   └── Shape                ← vector shape (shape.c.ts)
│       └── ShapeButton      ← interactive shape with colors/callbacks (shape-button.c.ts)
│           └── HoldShapeButton
└── NineSlicePlane           ← 9-slice sprite (nine-slice-plane.c.ts)
```

All `.c.ts` = Thing-Editor component (registered in editor).

---

## Component (`.c.ts`) Skeleton

```typescript
import editable from 'thing-editor/src/editor/props-editor/editable';
import game from 'thing-editor/src/engine/game';
import { Container } from 'pixi.js';
import getValueByPath from 'thing-editor/src/engine/utils/get-value-by-path';

export default class MyComponent extends Container {

  // Serialized editable properties (appear in editor panel)
  @editable()
  myNumber = 0;

  @editable({ type: 'color' })
  myColor = 0xffffff;

  @editable({ type: 'data-path' })
  targetPath = '';   // resolved at runtime with getValueByPath()

  private target: Container | null = null;

  init() {          // called once when added to stage (MUST call super.init())
    super.init();
    if (this.targetPath) {
      this.target = getValueByPath(this.targetPath, this);
    }
    this.on('pointerdown', this.handleDown);
  }

  onRemove() {      // called when removed from stage
    super.onRemove();
    this.removeListener('pointerdown', this.handleDown);
  }

  update() {        // called every frame
    super.update(); // propagates update() to children
  }

  _onRenderResize() {  // called on window resize
    // reposition for new screen size
  }

  private handleDown = () => { /* ... */ };
}

/// #if EDITOR
MyComponent.__EDITOR_icon = 'tree/container';
/// #endif
```

**Rules:**
- Always `super.init()` first in `init()`
- Always `super.onRemove()` in `onRemove()`
- `super.update()` propagates update to children — omit only if you manage children yourself
- Remove all listeners in `onRemove()`
- Code between `/// #if EDITOR` and `/// #endif` stripped from runtime build

---

## Scene JSON Format (`*.s.json` / `*.p.json`)

```json
{
  "c": "ClassName",
  "p": {
    "name": "uniqueName",
    "x": 0,
    "y": 0,
    "alpha": 1,
    "visible": true,
    "rotation": 0,
    "scale.x": 1,
    "scale.y": 1,
    "skew.x": 0,
    "skew.y": 0,
    "pivot.x": 0,
    "pivot.y": 0,
    "interactive": false,
    "image": "textureName",
    "tint": 16777215,
    "backgroundColor": 276,
    "myCustomProp": "value"
  },
  ":": [
    { "c": "ChildClass", "p": { "name": "child1" } },
    { "r": "prefabName", "p": { "x": 100, "name": "prefabInst" } }
  ]
}
```

- `"c"` — class name string
- `"p"` — properties object. Nested props use dot notation: `"scale.x": 1.5`
- `":"` — children array
- `"r"` — prefab reference (instead of `"c"`). Properties in `"p"` override prefab defaults.
- `"name"` must be unique within the scene. Becomes key in `scene.all` map.

**DO NOT hand-edit** `main.s.json` or prefab files — use the editor UI. Edit only when specifically targeting a serialized property value.

---

## Transforms & Positioning

All from PixiJS — relative to parent:

| Property | Type | Notes |
|---|---|---|
| `x`, `y` | number | position in parent space |
| `scale.x`, `scale.y` | number | 1 = 100%. Dot notation in JSON. |
| `rotation` | number | radians. 0=up, PI/2=right |
| `alpha` | 0–1 | transparency |
| `visible` | bool | render & update skip if false |
| `pivot.x`, `pivot.y` | number | internal pivot for rotation/scale (relative to self) |
| `skew.x`, `skew.y` | number | shear |
| `anchor.x`, `anchor.y` | number | Sprite/DSprite only. 0.5 = center. Default for DSprite is 0.5. |

**DSprite default anchor = 0.5,0.5** — position is center of sprite. Plain Sprite defaults to 0,0 (top-left).

**No built-in layout system.** Position is manual. Custom layout logic goes in `_onRenderResize()` or custom services.

**Coordinate helpers on Container.prototype:**
```typescript
obj.getGlobalRotation(): number          // rotation summed up to stage
obj.getScenePosition(point?): Point      // convert to stage-local coords
obj.getRootContainer(): Container        // top scene/prefab root
obj.findParentByType(Class): Container   // walk up by type
obj.findParentByName(name): Container    // walk up by name
obj.findChildByName(name): Container     // search all descendants
obj.findChildrenByType(Class): T[]       // all descendants of type
obj.forAllChildren(cb): void             // recurse all descendants
obj.detachFromParent(): void             // remove from parent
```

---

## Scene Management (`game` singleton)

```typescript
import game from 'thing-editor/src/engine/game';

// Scene stack
game.showScene('sceneName')                  // push scene (with fader)
game.showScene('sceneName', 'fader/custom')  // with custom fader
game.replaceScene('sceneName')              // pop current + push new
game.closeCurrentScene()                    // pop top scene
game.closeAllScenes()                       // pop all except bottom

// Modals (overlay, blocks scene interaction)
game.showModal('prefabName')                // load prefab as modal
game.showModal(containerInstance)
game.hideModal()                            // hide top modal

// State
game.currentScene: Scene                   // active scene
game.currentContainer: Container           // top modal or current scene
game.stage: Container                      // root PIXI container
game.pixiApp: PIXI.Application             // raw Application (renderer, ticker)
game.W, game.H: number                     // logical game dimensions
game.isPortrait: boolean
game.isMobile.any: boolean                 // also .ios, .android, .tablet, .phone (from PIXI.utils.isMobile)
game.mouse: Mouse                          // extends PIXI.Point — has x, y, click
game.time: number                          // frame counter
game.all: ThingSceneAllMap                 // shortcut to currentScene.all
game.data: GameData                        // user-defined shared state
game.classes: GameClasses                  // class registry (from .tmp/classes.js)
game.fullscreen: FullScreen                // FullScreen helper

// Utilities
game.openUrl(url, target?)                 // safe external link
game.showQuestion(title, message, yesLabel?, yesCb?, noLabel?, noCb?)  // yes/no modal
game.forAllChildrenEverywhere(cb)          // iterate all nodes (scenes + modals)

// Events
game.on('update', cb)                      // every frame
game.on('updated', cb)                     // after frame update
game.on('stage-will-resize', cb)
game.on('onLanguageChanged', cb)

// Loading
game.loadingAdd(owner)                     // increment loading counter
game.loadingRemove(owner)                  // decrement
game.loadingProgress: number               // 0-100
```

**`scene.all`** — flat map of ALL named objects in scene (populated by `_refreshAllObjectRefs()`). Access as `game.all.myObjectName`.

---

## Data Path System

`getValueByPath(path, thisObj)` — resolves a string path to a live object or property.

```typescript
import getValueByPath from 'thing-editor/src/engine/utils/get-value-by-path';
import { setValueByPath } from 'thing-editor/src/engine/utils/get-value-by-path';

// In component:
const target = getValueByPath('all.cardFactory', this);     // scene.all lookup
const sprite = getValueByPath('this.#spriteChild', this);   // private field
const val = getValueByPath('data.score', this);             // game.data.score

setValueByPath('all.labelText.text', 'Hello', this);
```

**Path syntax:**
- `this.propName` — property on current object
- `all.objectName` — named scene object via `scene.all`
- `all.objectName.propName` — property on named scene object
- `data.key` — `game.data.key`
- Dot-chained: `all.parent.child.value`

Use `@editable({ type: 'data-path' })` for paths set in editor.

---

## `@editable()` Decorator

Declares a serialized property editable in Thing-Editor's inspector.

```typescript
import editable from 'thing-editor/src/editor/props-editor/editable';

@editable()                                          // number input
@editable({ type: 'string' })                       // text input
@editable({ type: 'boolean' })                      // checkbox
@editable({ type: 'color' })                        // color picker (hex int)
@editable({ type: 'number', step: 0.01, min: 0, max: 1 })
@editable({ type: 'data-path' })                    // path selector
@editable({ type: 'callback', important: true })    // callback path array (string[])
@editable({ type: 'image' })                        // texture picker
@editable({ type: 'sound' })                        // sound picker
@editable({ type: 'prefab' })                       // prefab selector
@editable({ type: 'select', select: [{name,value}] })
@editable({ type: 'splitter', title: 'Section' })  // visual separator (not serialized)
@editable({ type: 'btn', name: 'Label', onClick: fn }) // editor button
@editable({ type: 'rect' })                         // {x,y,w,h} editor
@editable({ type: 'ref' })                          // reference to scene object
@editable({ type: 'l10n' })                         // localization key picker
@editable({ type: 'timeline' })                     // MovieClip timeline data
@editable({ type: 'curve' })                        // bezier curve editor
@editable({ type: 'slider', min: 0, max: 1 })       // slider input
@editable({ type: 'resource' })                     // generic resource picker
@editable({ type: 'pow-damp-preset' })              // physics preset
@editable({ type: 'spine-sequence' })               // Spine animation sequence
@editable({ animate: true })                        // can be keyframed in MovieClip timeline
@editable({ notSerializable: true })               // shown in editor but not saved to JSON
@editable({ visible: (obj) => obj.someFlag })      // conditional visibility
```

All `@editable` props are auto-serialized to scene/prefab JSON and restored on load.

---

## MovieClip Timeline Animation

`MovieClip extends DSprite`. Animates any `@editable({ animate: true })` property.

```typescript
// In editor: add keyframes via timeline panel
// At runtime:
mc.isPlaying = true / false
mc.gotoLabelRecursive('labelName')   // jump to label in this and all children
```

**Timeline JSON structure** (stored in `"timeline"` property):
```json
{
  "f": [
    {
      "n": "x",
      "t": [
        { "t": 0, "v": 0,   "m": 0 },
        { "t": 30, "v": 100, "m": 1 }
      ]
    }
  ],
  "l": { "idle": 0, "run": 30 },
  "p": 2,
  "d": 0.2
}
```
- `f` — field players (each animates one property `n`)
- `l` — labels (name → frame time)
- `t` in keyframe = time, `v` = value, `m` = interpolation mode
- `a` = callback path called at that frame

---

## TickerTween

Frame-based tween. Own `PIXI.Ticker` per instance — runs independently of game pause.

```typescript
import TickerTween, { Easing } from 'thing-editor/src/engine/lib/assets/src/utils/TickerTween';

const tween = new TickerTween(targetDisplayObject, durationInSeconds)
  .to(
    () => obj.x,           // getter
    (v) => obj.x = v,      // setter
    100,                   // toValue (number)
    Easing.outCubic        // easing
  )
  .moveTo({ x: 100, y: 200 }, Easing.inOutCubic)   // shorthand for position
  .scaleTo({ x: 1.5, y: 1.5 }, Easing.outBack)     // shorthand for scale
  .alphaTo(0, Easing.inCubic)                        // shorthand for alpha
  .colorTo(() => obj.tint, (v) => obj.tint = v, 0xff0000, Easing.none) // 3rd arg = toColor (number)
  .onUpdate((t) => { /* t = 0..1 */ })
  .onComplete(() => { /* done */ })
  .yoyo(true, 3)           // ping-pong, 3 times
  .start();

tween.pause();
tween.restart();
tween.finish();            // jump to end immediately
tween.setProgress(0.5);   // jump to 50%
tween.destroy();           // MUST call when done or owner removed
```

**Easings:**
`Easing.none`, `inCubic`, `outCubic`, `inOutCubic`, `inBack`, `outBack`, `outBounce`, `inOutBounce`, `easeOutBack`, `outBackNotStrong`

**Always destroy tweens in `onRemove()`** — they hold a Ticker reference.

---

## Shape Component

```typescript
import Shape, { SHAPE_TYPE } from 'thing-editor/src/engine/lib/assets/src/extended/shape.c';

shape.shape          // SHAPE_TYPE enum
shape.shapeFillColor // number (0xRRGGBB)
shape.shapeFillAlpha // 0–1
shape.shapeLineColor
shape.shapeLineWidth
shape._shapeRadius   // for ROUND_RECT / CIRCLE
// _width, _height set via editor
```

**SHAPE_TYPE:** `RECT=0`, `ROUND_RECT=1`, `CIRCLE=2`, `ELLIPSE=3`, `POLY=4`, `CUSTOM_ROUND_RECT=5`

---

## ShapeButton

Extends `Shape`. Interactive button with states, sounds, scale animation.

Key editable props:
- `normalColor`, `hoverColor`, `pressColor`, `disabledColor` — fill colors per state
- `enabled` — enable/disable
- `onClick: string[]` — callback paths called on click
- `onOverCallback`, `onOutCallback`
- `isScaleOnHover`, `isScaleOnClick` — auto-scale feedback
- `isSmoothChangeColor` — animate color transitions
- `sndClick`, `sndOver` — sound keys
- `diTargets: string[]` — DI-based targets: `"targetName,methodName,param"`

```typescript
button.enabled = false;
button.click();                          // programmatic click
button.onClickCallback = () => { };     // override at runtime
```

---

## Sprite / Image

```typescript
sprite.image = 'textureName';   // set texture (Lib registered name)
sprite.tint = 0xff0000;         // multiply color (0xFFFFFF = no tint)
sprite.anchor.set(0.5);         // center pivot (DSprite default)
sprite.blendMode = BLEND_MODES.ADD;
```

---

## Prefabs

- Defined in `assets/*.p.json` files
- Loaded via `Lib.loadPrefab('prefabName')` → returns new instance
- In scene JSON: `{ "r": "prefabName", "p": { overrides } }`
- Overrides in `"p"` replace prefab defaults

```typescript
import Lib from 'thing-editor/src/engine/lib';

const inst = Lib.loadPrefab('cardItemPrefab');
inst.x = 100;
someContainer.addChild(inst);

// As modal:
game.showModal('ui/my-popup');
```

---

## Asset Access

```typescript
import Lib from 'thing-editor/src/engine/lib';

Lib.getTexture('textureName'): Texture
Lib.hasTexture('name'): boolean
Lib.loadScene('sceneName'): Scene
Lib.loadPrefab('prefabName'): Container
Lib.hasPrefab('name'): boolean
Lib.destroyObjectAndChildren(obj, withHolder?): void
```

---

## Sound

```typescript
game.Sound.play('soundKey');
game.Sound.stop('soundKey');
game.Sound.setVolume('soundKey', 0.5);
```

---

## DI (tsyringe)

Services registered in `installers.ts`:

```typescript
import { container } from 'tsyringe';
import { EventBusToken } from 'libs/skill-games-client-lib/...';

const eventBus = container.resolve(EventBusToken);
```

Common tokens: `EventBusToken`, `ClientProviderToken`, `ConnectionServiceToken`

---

## Scene Lifecycle

1. `game.showScene('name')` → fader starts
2. Fader covers screen → `Lib.loadScene('name')` called
3. Scene deserialized: tree built, then `constructRecursive()` calls `init()` **top-down** (parent first, then each child)
4. `scene._refreshAllObjectRefs()` → builds `scene.all` map
5. Fader hides → `scene.onShow()` called + `'on-scene-show'` event
6. Each frame: `game.emit('update')` → `currentContainer.update()` recurses tree
7. On close: `scene.onHide()` → children `onRemove()` called → destroyed

---

## Update Loop

```
game.emit('global-update')        // before frame steps
  → game.emit('update')           // each logic frame (60fps target)
      → currentContainer.update() // recurses all children
      → currentFader.update()     // fader if active
  → game.emit('updated')          // after frame
```

`FRAME_PERIOD = 1.0` (delta units at 60fps). Time-based animations use `dt` from ticker.

---

## Localization

```typescript
import { l } from 'thing-editor/src/engine/utils/l';

l('key')                              // returns localized string
game.emit('onLanguageChanged', id)    // triggers re-layout
```

Text files in `assets/l18n/*.json`.

---

## Preprocessor Guards

```typescript
/// #if EDITOR
// editor-only code (stripped from production build)
/// #endif

/// #if DEBUG
// debug-only code
/// #endif

/// #if NOT-EDITOR
// runtime-only code
/// #endif
```

Vite plugin strips these at build time.

---

## `game.data`

Use `game.data` as a typed bag for game-level state accessible via data-path:

```typescript
// anywhere
(game.data as any).score = 100;

// in data-path strings
"data.score"
```

---

## Common Patterns

**Find object at runtime:**
```typescript
// From anywhere in scene:
const factory = game.all.cardFactory as CardFactory;

// From component (scene-relative):
const sibling = this.findParentByType(Scene)!.all.myObject;
```

**Remove self:**
```typescript
this.remove();                // safe — wraps obj in invisible RemoveHolder, destroyed next frame
this.removeWithoutHolder();   // immediate destroy (don't call mid-update on self)
```
`Lib.destroyObjectAndChildren(obj, itsRootRemoving?)` is the underlying impl. Pool-aware classes return to pool on destroy.

**Add filter:**
```typescript
import { OutlineFilter } from '@pixi/filter-outline';
this.addFilter(new OutlineFilter(2, 0xff0000));
this.removeFilter(existingFilter);
```

**Screen-space coordinate:**
```typescript
const scenePos = new Point();
this.getScenePosition(scenePos);
```

---

## Built-in Component Catalog

All in `thing-editor/src/engine/lib/assets/src/{basic,extended}/`. Each is a `.c.ts` file usable via `"c": "ClassName"` in scene JSON.

### Basic — display/render

| Class | Extends | Purpose |
|---|---|---|
| `Container` | PIXI.Container | Empty group/transform |
| `Sprite` | PIXI.Sprite | Image (`image` prop = texture key) |
| `DSprite` | Sprite | Sprite + `xSpeed/ySpeed/rSpeed`. Default anchor 0.5. |
| `MovieClip` | DSprite | DSprite + timeline animation |
| `Text` | PIXI.Text | Single-line styled text |
| `MultilineText` | Text | Wrap-aware multi-line text |
| `FlyText` | Text | Floating/popping text effect |
| `BitmapText` | PIXI.BitmapText | Pre-baked font text |
| `CircularBitmapText` | — | BitmapText along a curve |
| `Shape` | PIXI.Graphics | Vector shape (RECT/ROUND_RECT/CIRCLE/ELLIPSE/POLY/CUSTOM_ROUND_RECT) |
| `Fill` | PIXI.Mesh | Mesh-based gradient/pattern fill |
| `BackDrop` | Shape | Full-screen background rect |
| `NineSlicePlane` | PIXI 9-slice | Stretchy bordered sprite |
| `Rope` | PIXI.Mesh | Sprite stretched along points |
| `Trail` | Rope | Motion-trail rope |
| `CurveAnimatedRope` | — | Rope animated along bezier curve |
| `ParticleContainer` | Container | High-perf many-sprite container |
| `ParticleSystem` | — | Wraps `@pixi/particle-emitter` |
| `Spawner` | Container | Periodically spawns prefabs |
| `SpawnerRing` | — | Spawns in radial pattern |
| `BgMusic` | Container | Background music controller (auto-managed by faders) |

### Basic — interactive

| Class | Extends | Purpose |
|---|---|---|
| `Button` | DSprite | Sprite-based button with `onClick: string[]` callbacks |
| `ShapeButton` | Shape | Vector-shape button with state colors + tween animation |
| `HoldShapeButton` | ShapeButton | Long-press button |
| `NineSliceButton` | NineSlicePlane | 9-slice stretchable button |
| `GradientButton` | ShapeButton | Gradient-fill button |
| `UniversalButton` | SizedContainer | Composite button (any layout inside) |
| `Toggle` | ShapeButton | On/off toggle button |
| `Checkbox` | ShapeButton | Checkbox |
| `RadioButton` | ShapeButton | Radio group member |
| `LinkDomButton` | — | Opens external URL via DOM anchor |
| `ClickOutsideTrigger` | Container | Fires when click happens outside its bounds |
| `StaticTrigger` | Container | Fires once on init |

### Basic — system

| Class | Purpose |
|---|---|
| `Scene` | Scene root. Has `backgroundColor`, `isStatic`, `faderType`, virtual `onShow/onHide/onMouseDown/onMouseUp/onMouseMove`. |

### Extended

| Class | Extends | Purpose |
|---|---|---|
| `SizedContainer` | Container | Container with explicit `width/height` for layout |
| `LayeredContainer` | Container | Children rendered in another container ("portal") |
| `LayeredContainerPortal` | Container | Sibling end of LayeredContainer; receives the redirected children |
| `Mask` | Container | Renders children as mask for siblings |
| `Resizer` | Container | Re-positions children on resize per rules |
| `ParentResizer` | Resizer | Auto-resizes parent Shape's width/height to its own |
| `OrientationTrigger` | Container | Show/hide children per portrait/landscape |
| `OrientationParentResizer` | OrientationTrigger | Combined orientation + parent resize |
| `ScrollLayer` | Container | Scrollable area |
| `ScrollBar` | Shape | Scrollbar widget |
| `ProgressBar` | Container | Fill-bar widget |
| `Label` | Text | Localized auto-resizing text |
| `BackgroundImage` | MovieClip | Cover/contain background image |
| `HtmlOverlay` | ScrollLayer | HTML element overlay synced with PIXI transform |
| `Spine` | Container | spine-pixi animation host (uses `pixi-spine` v4) |
| `Trigger` | Container | Conditional show/hide based on data-path value |
| `IsMobileTrigger` | OrientationTrigger | Show only on mobile |
| `ShapeGradient` | Shape | Shape with gradient fill |
| `ParticleShort` | DSprite | Lightweight short-duration particle |

### System assets (`___system/`)

| Asset | Purpose |
|---|---|
| `Delay` | Frame-counted scene-linked timer |
| `SceneLinkedPromise` | Promises auto-cancelled on scene exit |
| `backdrop.p.json` | Default modal backdrop |
| `gizmo.p.json`, `guide.p.json`, `rect-guide.p.json` | Editor visual helpers |
| `unknown-prefab.p.json` | Placeholder for missing prefabs |

---

## Delay (frame-based timer)

Scene-linked replacement for `setTimeout`. Auto-cancels if scene closes. Visible in editor tree.

```typescript
import Delay from 'thing-editor/src/engine/lib/assets/___system/delay.c';

const d = Delay.delay(() => { console.log('done'); }, 30);  // 30 frames = 0.5s
d.remove();   // cancel
d.skip();     // fire callback immediately
```

Optional 3rd arg = container to attach to (default `game.currentContainer`). Closing that container cancels the delay.

---

## SceneLinkedPromise

Promise tied to scene lifetime — rejects/disposes if scene is destroyed.

```typescript
import SceneLinkedPromise from 'thing-editor/src/engine/lib/assets/___system/scene-linked-promise.c';

SceneLinkedPromise.promise((resolve, reject) => {
  // async work
  resolve(data);
}, ownerContainer)
.then(d => { /* ok */ })
.catch(e => { /* err */ })
.finally(() => { /* cleanup */ });

SceneLinkedPromise.all([p1, p2], owner).then(([d1, d2]) => { });
SceneLinkedPromise.resolve(value);
```

---

## Pool (object reuse)

```typescript
import Pool from 'thing-editor/src/engine/utils/pool';

const obj = Pool.create(MyClass);   // get from pool or `new MyClass()`
Pool.dispose(obj);                  // return to pool
Pool.clearAll();                    // empty all pools
```

Used internally by `MovieClip.fieldPlayers`, `Delay`, `SceneLinkedPromise`. Returned objects must have `children.length === 0`.

---

## callByPath

Invokes a function via path string. Used by editor's callback fields (`@editable({ type: 'callback' })`).

```typescript
import callByPath from 'thing-editor/src/engine/utils/call-by-path';

callByPath('all.gameController.start', this);
callByPath('this.doSomething,arg1,arg2', this);     // comma-separated args
callByPath('data.score,100', this);                 // sets game.data.score = 100 if it's setValueByPath
```

**Path syntax in callback strings:**
- `all.objName.method` — call method on named scene object
- `this.method` — call method on owner
- Comma `,` separates parameters (path is `string.split(',')`-ed)
- DI targets in ShapeButton use the same comma syntax: `"targetName,methodName,param"`

---

## Keys (input)

```typescript
import { Keys } from 'thing-editor/src/engine/utils/keys';

Keys.up / down / left / right       // arrow + WASD (booleans)
Keys.shiftKey / ctrlKey / altKey    // modifier booleans
Keys.all: Set<number>               // raw keyCode set

// On game singleton (proxy to Keys):
game.keys.up / down / left / right
game.keys.shiftKey / ctrlKey / altKey
```

`Keys.update()` runs in `_updateGlobal()` after frame — keyup events queued and applied between frames.

---

## Settings (persistent storage)

```typescript
game.settings.getItem(key, defaultValue)
game.settings.setItem(key, value)
game.settings.removeItem(key)
```

Backed by `localStorage`, scoped to `gameId` passed to `game.init()`.

---

## Static Scenes

A scene with `isStatic = true` is **not destroyed** when popped from stack. Useful for HUD-like scenes that retain state.

```typescript
@editable() isStatic = false;       // Scene base property
```

Static scenes accessed via `Lib._getStaticScenes()`. They run their `update()` even when not the active scene if added to stage.

---

## Scene Mouse Handlers (virtual)

Override on Scene subclass — called automatically:

```typescript
export default class MyScene extends Scene {
  onShow() { /* called once after fader hides */ }
  onHide() { /* called when scene popped */ }
  onMouseDown(mouse, ev: PointerEvent) { /* mouse = game.mouse */ }
  onMouseUp(mouse, ev) { }
  onMouseMove(mouse, ev) { }
}
```

---

## Editor Metadata (class-level)

```typescript
MyComponent.__EDITOR_icon = 'tree/container';   // tree-view icon (paths under thing-editor/img/)
MyComponent.__className = 'MyComponent';        // auto-set; used in serialization
MyComponent.__defaultValues = { foo: 1 };       // default field values
MyComponent.__canAcceptParent = (parent) => { return true; };  // allow/deny parent class
MyComponent.__beforeDestroy = function() { };   // cleanup hook
MyComponent.__EDITOR_onCreate = function() { }; // called when added in editor
```

Available editor icons in `thing-editor/img/tree/*.png`: container, sprite, dsprite, scene, button, timer, unknown-class, etc.

---

## Build Artifacts (`.tmp/`)

Generated by editor's `Build` action. Loaded at runtime by `game.init()`:

| File | Contents |
|---|---|
| `.tmp/classes.ts` | All custom + engine classes (registered into `game.classes`); transpiled by Vite |
| `.tmp/assets-preloader.json` | Minimal assets for preloader scene (loaded immediately) |
| `.tmp/assets-main.json` | Main game assets (loaded after preloader scene shows) |
| `.tmp/assets-delayed.json` | Delayed assets (loaded after main scene starts) |

`AssetsDescriptor` schema:
```typescript
{
  prefabs: { [name]: SerializedObject },
  scenes: { [name]: SerializedObject },
  images: string[],
  sounds: [string, SoundMetadata][],
  text?: LanguageData,
  resources?: string[],
  xmls?: { [name]: string },
  fonts?: string[],
  projectDesc?: ProjectDesc
}
```

---

## Fader System

Faders are **prefabs** under `assets/fader/*.p.json`. Default = `fader/default`. They're MovieClips. The default fader has ONE explicit label `hide fader`; the "show" phase is just the timeline playing from frame 0. Callbacks are wired into the timeline via keyframe `"a"` (action) entries:
- Frame 0..N: fade-in plays automatically (no label needed)
- At a keyframe `"a": "faderShoot"` → engine swaps the scene
- At label `hide fader`: fade-out plays
- At a keyframe `"a": "faderEnd"` → fader destroyed

When `game.showScene()` is called:
1. Fader prefab loaded, added to stage
2. Scene starts loading; fader timeline plays from frame 0 (fade-in)
3. Fader timeline fires `game.faderShoot()` when fully covering
4. Engine swaps current scene
5. Fader jumps to `hide fader` label and plays fade-out
6. Fader timeline fires `game.faderEnd()` → fader destroyed

Set per-scene fader:
```typescript
@editable({ type: 'prefab', filterAssets: f => f.assetName.startsWith('fader/') })
faderType: string | null = null;     // on Scene class
```

Or pass to `game.showScene(name, 'fader/custom')`.

---

## Spine Support

`Spine` component wraps `pixi-spine` v4. Atlas + JSON skeleton loaded as assets. Supports `gotoLabelRecursive` for animation triggers.

---

## Particles

- `ParticleContainer` — PIXI's batched container (high perf, limited features)
- `ParticleSystem` — wraps `@pixi/particle-emitter` v5 (full emitter w/ behaviors, JSON-config)

---

## Resize Handling

`game._onContainerResize()` fires on `window.resize`, schedules `onResize()` at multiple delays (1, 20, 40, 80, ... ms) to handle iOS quirks.

`onResize()` recalculates `game.W/H` based on:
- `projectDesc.screenOrientation: 'auto' | 'landscape' | 'portrait'`
- `projectDesc.dynamicStageSize` — if true, W/H reflect window aspect; else fixed
- `projectDesc.renderResolution` / `renderResolutionMobile`
- `game.isMobile.any` (mobile detection)

After resize, all containers receive `_onRenderResize()` recursively (one frame later via `requestAnimationFrame`).

`game.emit('stage-will-resize')` fires before recalc.

---

## ProjectDesc (`thing-project.json`)

Schema: `thing-editor/src/engine/lib/schema-thing-project.json`.

```json
{
  "id": "durak",
  "screenOrientation": "auto" | "landscape" | "portrait",
  "mobileOrientation": "auto" | "landscape" | "portrait",
  "dynamicStageSize": true,
  "width": 1920,
  "height": 1080,
  "portraitWidth": 1080,
  "portraitHeight": 1920,
  "renderResolution": 1,
  "renderResolutionMobile": 1,
  "scaleMode": "nearest" | "linear",
  "defaultFont": "Roboto",
  "preloadScene": "preloader",
  "libs": ["ui-common-lib", "skill-games-client-lib"],
  "lowQualityVariants": { "img/big.png": "img/big-lowq.png" },
  "loadOnDemandSounds": { "soundKey": 1|2 },
  "framesSkipLimit": 4,
  "soundFormats": ["webm", "mp3"],
  "jpgQuality": 80,
  "embedLocales": true,
  "webfontloader": { ... }
}
```

There is **no `mainScene` field** — the engine boots into `preloadScene`; from there your code calls `game.showScene('...')`.

---

## Editor Tips

- **Tree panel** — left side, drag/drop reorder; right-click for context menu
- **Property inspector** — right side; `@editable` props appear here
- **Viewport** — center; click-select objects, hold Shift to multi-select
- **Timeline** — bottom; appears for selected MovieClip; add keyframes for `@editable({ animate: true })` props
- **Save** — Ctrl+S writes scene/prefab to JSON
- **Build** — generates `.tmp/*` for runtime
- **Hotkeys**: arrow keys nudge selection, Shift snaps rotation to 22.5°
- **`__hideInEditor: true`** — hides node in viewport (still rendered at runtime)
- **`__doNotSelectByClick: true`** — prevents click selection (still selectable in tree)
- **`__description`** — author notes on node

---

## Common Gotchas

1. **`init()` called top-down** — parent's `init()` runs before children's (`constructRecursive()` in `lib.ts`). A child's `init()` CAN read `parent.something` set in parent's `init()`. The opposite is NOT true: parent's `init()` runs before children are initialized, so don't touch `child.foo` (set in child's init) from the parent's own `init()`.
2. **`super.init()` MUST be called** — schedules `_onRenderResize()`.
3. **Removing listeners in `onRemove()` is mandatory** — orphaned listeners cause memory leaks + ghost callbacks.
4. **Don't hand-edit `.s.json`/`.p.json`** — editor sorts keys, can produce massive diffs.
5. **`game.all` is the active scene's `all`** — modal containers don't have `all`.
6. **Naming convention**: avoid `.`, `#`, backtick, `,` in object names — these are data-path/callback separators. Sanitization is enforced in localization keys and timeline field names (not globally on every name), so a stray `.` in `obj.name` may not crash but will silently break `getValueByPath('all.objName')`.
7. **DSprite's anchor 0.5** trips up new devs expecting top-left origin.
8. **`update()` called even when `visible=false`** unless overridden — only render is skipped.
9. **TickerTween creates own PIXI.Ticker** — leaking them costs CPU; always `.destroy()`.
10. **MovieClip with no timeline still works** — sets `_timelineData = null`, no error.
