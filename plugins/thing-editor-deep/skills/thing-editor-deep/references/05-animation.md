# Animation: MovieClip Timeline + FieldPlayer + Curve + Spine + SceneLinkedPromise + Delay

## Timeline JSON schema

`thing-editor/src/engine/lib/assets/src/basic/movie-clip/field-player.ts` L112-124:

```typescript
interface TimelineSerializedData {
  l: KeyedMap<number>;           // labels: name → time (frame)
  f: TimelineSerializedFieldData[];  // animated fields
  p: number;                     // pow (acceleration, ~0.02 typical)
  d: number;                     // damp (~0.85 typical)
}

interface TimelineSerializedFieldData {
  n: string;                     // property name (x, y, alpha, rotation, etc.)
  t: TimelineSerializedKeyFrame[];  // keyframes
}

// Partial<TimelineKeyFrame> in serialization
interface TimelineKeyFrame {
  t: number;                     // absolute frame
  v: number | string | boolean;  // value
  m: TimelineKeyFrameType;       // 0=SMOOTH 1=LINEAR 2=DISCRETE 3=BOUNCE_BOTTOM 4=BOUNCE_TOP
  j: number;                     // jump/loop time (default = t)
  s?: number;                    // optional speed override (LINEAR only)
  r?: number;                    // random delay range (0..r frames)
  a?: string;                    // callback action path
  g?: number;                    // gravity (BOUNCE only)
  b?: number;                    // bounce coefficient (BOUNCE, negative)
}
```

Serialization compacts defaults: omits `m` if SMOOTH (0), `r` if 0, `j` if equal to `t`.

## Keyframe modes

```typescript
enum TimelineKeyFrameType {
  SMOOTH = 0,         // pow-damp eased
  LINEAR = 1,         // constant speed
  DISCRETE = 2,       // instant jump
  BOUNCE_BOTTOM = 3,  // gravity + elastic floor
  BOUNCE_TOP = 4      // gravity + elastic ceiling
}
```

Non-numeric properties (string/boolean/color) → only DISCRETE allowed.

`get-keyframe-types-for-field.ts` L6-45:
- Numbers: all 5 types
- x/y/rotation default → SMOOTH
- alpha default → LINEAR
- Non-numbers default → DISCRETE

## FieldPlayer mechanics

Each MovieClip has `fieldPlayers: FieldPlayer[]` array (one per animated field), pooled.

`init(target, data, pow, damper)` L165-173: stores refs, calls reset()

`reset()` L175-208:
- `time = 0`, `speed = 0`, `currentFrame = timeline[0]`
- applies random delay `r` if present
- `val = currentFrame.v`

`update()` L225-324 — runs per frame:

**At keyframe boundary** (`time === currentFrame.t`) L234-293:
1. Fire `currentFrame.a` callback if exists: `callByPath(action, this.target)`
2. Apply easing per mode (SMOOTH: damp toward target; LINEAR/DISCRETE: instant)
3. `time = currentFrame.j` (loop point)
4. Apply random delay
5. Apply set-speed override if `s` present
6. Compute next-frame transition:
   - LINEAR: `speed = (nextKeyframe.v - val) / dist`
   - DISCRETE: `speed = 0`
   - SMOOTH: preserves current speed for continued easing
7. `currentFrame = currentFrame.n` (next keyframe pointer)

**Between keyframes** L294-320:

**SMOOTH:**
```
speed += (currentFrame.v - val) * pow;
val += speed;
speed *= damper;
```

**LINEAR:**
```
val += speed;  // pre-computed on entry
```

**BOUNCE_BOTTOM:**
```
speed += currentFrame.g;  // gravity pulls down
val += speed;
if (val >= currentFrame.v) {  // hit floor
  val = currentFrame.v;
  speed *= currentFrame.b;  // bounce (b negative)
}
```

**BOUNCE_TOP:** Inverted gravity, hits ceiling.

**Every frame** L321-322:
```
time++;
target[fieldName] = val;
```

`goto(time, nextKeyframe)` L210-223 — jump to label without resetting timeline:
- LINEAR: recomputes speed for new dist
- DISCRETE: speed=0
- SMOOTH: preserves speed

## MovieClip integration

`movie-clip.c.ts`:

`set timeline(data)` L40-80:
- caches `TimelineData` (deserialized form) in `deserializeCache` WeakMap
- creates FieldPlayer per field via Pool

`_deserializeTimelineData()` L180-231:
- fills defaults (j=t, m=SMOOTH)
- computes next-keyframe linked list pointers
- builds label index: each label has `n` array (next keyframes per field)

`update()` L147-167:
- if `delay > 0`: decrement
- if `_goToLabelNextFrame`: `fieldPlayers[i].goto(label.t, label.n[i])`
- else: `fieldPlayers.forEach(p => p.update())`
- super.update()

`get timeline()` L84-138 (EDITOR): re-serializes by removing defaults.

`_disposePlayers()` L233-237: `Pool.dispose` each on timeline change.

## Labels & gotoLabel

```typescript
interface TimelineLabelData {
  t: number;                  // label time
  n: TimelineKeyFrame[];      // pre-computed next keyframe per field
  ___name: string;
  ___view?: TimelineLabelView;
  ___key?: number;
}
```

`hasLabel(name)` L245-251
`gotoLabel(name)` L254-258: sets `_goToLabelNextFrame = name`, calls `play()`
`gotoLabelIf(name, path, invert)` L270-274: conditional via `getValueByPath`
`gotoLabelRecursive(name)` L305-311: walks children too (`super.gotoLabelRecursive`)

`stop()` is decorated with `___EDITOR_actionIcon = R.img({src: '/thing-editor/img/timeline/stop.png'})`.

## IGoToLabelConsumer interface

```typescript
interface IGoToLabelConsumer {
  gotoLabel(label: string): void;
  gotoLabelRecursive(label: string): void;
  __getLabels(): undefined | string[];
}
```

Implementers: MovieClip, Spine (sequences), Container (no-op recurse default).

`decorateGotoLabelMethods(constructor)` (`goto-label-consumer.ts` L81-88) marks methods as good for callback chooser with parameter helper for label name selection.

## TickerTween (code-driven animation)

Used by ShapeButton, Checkbox, Toggle, RadioButton, etc. for color/scale/alpha animations.

```typescript
import TickerTween, { Easing } from 'thing-editor/...';  // exact path varies

new TickerTween(card, 0.3)               // target, durationSeconds
  .moveTo({ x: target.x, y: target.y }, Easing.outCubic)
  .to(() => card.angle, v => card.angle = v, target.angle, Easing.outCubic)
  .alphaTo(0.5, Easing.linear)
  .onComplete(() => tween.destroy())
  .start();
```

Composable, callback hooks, manual destroy required (or onComplete cleanup).

`Easing` namespace has standard easings: linear, in/outCubic, in/outQuad, in/outSine, bounce variants, etc.

## Curve (animation curves)

`engine/utils/curve.ts`:

```typescript
interface SerializedCurve {
  k: CurveKeyFrame[];
  p?: number;   // pow default 0.2
  d?: number;   // damper default 0.85
}
interface CurveKeyFrame {
  t: number;       // 0-1 normalized time
  v: number;       // value
  m: CurveKeyFrameMode;  // LINEAR | SMOOTH | DISCRETE
}
```

Methods:
- `evaluate(time: 0-1) → number` — interpolated value
- `addKeyframe(t, v, m)` — adds/replaces at t
- `removeKeyframe(t)` — keeps min 2 frames
- `updateKeyframeTime/Value/Mode()`
- `setSmoothParams(pow, damper)`
- `serialize()` → SerializedCurve

Default: `[{t:0,v:0,m:LINEAR}, {t:1,v:1,m:LINEAR}]`

Time clamped 0-1. Single keyframe returns that value.

## curveHelper pattern

```typescript
@editable({ type: 'curve' }) myCurve?: SerializedCurve;
get myCurveInstance() { return curveHelper(this, 'myCurve')(); }

// usage
const v = this.myCurveInstance.evaluate(t / duration) * range;
```

Caches Curve instance in `_curveInstance_myCurve` property. **Not invalidated on field change** — clear cache manually if needed: `this._curveInstance_myCurve = undefined`.

## Particle Curves

ParticleSystem can use Curve for alpha/scale/speed (`alphaCurve`, `scaleCurve`, `speedCurve`):
- `curveToList(curve)` L137-145 samples 20 points → `{value, time}[]` for emitter

## Spine (extended/spine.c.ts ~1430 lines)

PIXI Spine wrapper with pool, LOD, atlas hijacking, sequences.

```
@editable _speed (min:-1, step:0.01)
@editable currentAnimation (validates against available animations)
@editable currentSkin (default 'default')
@editable isPlaying: boolean
@editable loop (getter/setter)
@editable speed (min:-1, step:0.01, controls timeScale)
@editable tint (calculated from parent or _tint)
@editable mixDuration (min:0, step:0.01)
@editable spinesPooling: boolean
@editable useParentTint: boolean (inherits from parent MovieClip)
@editable spineData (type:'resource')
```

### Atlas loading custom

`_initSpineParser()` L30-128 replaces default atlas parser:
- normalizes line endings
- checks `game.projectDesc.lowQualityVariants` for LOD swap
- resolves hashed via `unHashedFileToHashed.get(url)`
- supports cloud texture substitution via metadata

### Lifecycle

- `init()` L242-255: gets 'static-view' child, resets state
- `_initSpine()` L290-320: creates SpineContent from pool, sets `autoUpdate = false`, subscribes to LOD events
- `_releaseSpine()` L655-669: destroy/pool, unsubscribe events
- `onRemove()` L671-681: releases + clears listeners

### Animation control

- `play(animationName, mixDuration?)` L683-694
- `stop(isNeedRefresh?)` L757-766
- `playFromFrame(frame, animationName?, mixDuration?)` L701-715: `trackEntry.trackTime = frame / 60`
- `playIfDifferent(name, mixDuration, playIfStopped?)` L717-730
- `_applyAnimation()` L1127-1136 — editor fallback to first if not found

### Events (forwarded from pixi-spine state listener)

- `'spine:start'`, `'spine:interrupt'`, `'spine:end'`, `'spine:complete'`, `'spine:dispose'`, `'spine:event'`

### Sequences (scripted animation chains)

```typescript
interface SpineSequenceItem {
  n: string;                          // animation name
  mixDuration?: number;
  delay?: number;
  speed?: number;
  actions?: SpineSequenceItemAction[];
  ___next?: SpineSequenceItem;        // runtime linked list
  ___duration?: number;
}

interface SpineSequenceItemAction {
  a: string;                          // callback path
  t: number;                          // time in frames
  ___next?: SpineSequenceItemAction;
}

interface SpineSequence {
  n: string;
  s: SpineSequenceItem[];
  l?: number;                         // loop sequence index
}
```

- `_initSequencesByName()` L257-281: pre-computes linked lists + durations
- `_playSequenceItem(item)` L1096-1111: plays with speed/delay/actions
- `gotoLabel(label)` L1091-1094: queues label jump for next update
- `hasLabel(label)` L1113-1118
- Update loop L820-848: executes actions, handles sequenceDelay countdown, transitions to next item

### Atlas page texture replacement

`replaceAtlasPageTexture(newTexture, textureBaseName?)` L896-985:
- walks all slots and skins
- replaces matching baseTextures in region attachments
- handles sequence attachments with multiple frames
- cleans up old via `Lib._unloadTexture()`
- re-applies texture settings

### Pool

- `getSpineInstance(name)` L137-159: from pool or new, autoUpdate=false
- `disposeSpineInstance(o)` L161-167: resets to defaults, returns to pool
- `static allocatePool(name, count)` L1138-1151: pre-allocate
- `static clearPool(name?)` L1153-1167: destroy all
- `_poolName` field stores identity

### Static runtime loading

`static _loadSpineRuntime()` L1014-1070, auto-called at module load (L1375):
- loads pixi-spine via script tag (NOT ES module)
- patches SpineBase.createMesh for sequence attachments

### Settings

- `settings.REPORT_TEXTURE_LOADER_ERROR` gates error logging

### Editor

- `__previewFrame` slider for frame-by-frame preview
- `__validateObjectData` ensures spineData, currentAnimation, currentSkin exist
- `__validateSpineHasAnimation` checks sequence animation names
- Callback chooser markers on setCurrentAnimation/Skin/play/stop/toInitPose

## SceneLinkedPromise

`engine/lib/assets/___system/scene-linked-promise.c.ts` — **NOT native Promise**.

```typescript
static promise(handler, container?): SceneLinkedPromise   // L40-81
static resolve(data, container?): SceneLinkedPromise     // L83-87
static all(promises, container): SceneLinkedPromise     // L89-117
```

`static promise(handler, container)` L40:
- Pool.create(SceneLinkedPromise)
- adds to `container` or `game.currentContainer` or `game.currentFader`
- if container is currentFader/preloader: `game.loadingAdd(this)` (L50-55)
- handler receives `(resolve, reject, promise)` with wrapped IDs (L65-78)
- promiseId increments per pool reuse, prevents stale callbacks

`static all(promises, container)` L89-117:
- counter-based; if any rejects, sets results to error array, rejects parent
- finally handlers execute when all done

**Instance chaining (NON-NATIVE):**
- `.then(handler)` L173-177 — returns SAME instance, pushes to `_resolveHandlers[]`
- `.catch(handler)` L179-183 — pushes to `_rejectHandlers[]`
- `.finally(handler)` L185-189 — pushes to `_finallyHandlers[]`
- Asserts `_promiseWaitForResult === true` (no chaining after settle)

`update()` L241-340:
- Error path L249-286: process reject handlers, chain results, catch exceptions (re-throw via setTimeout)
- Resolve path L287-333: similar
- `_handleFinally()` always
- Self-removes if `!_promiseWaitForResult` (L337-339)

`onRemove()` L144-165:
- If still waiting → calls `_handleFinally()`
- Warns in editor if unresolved
- Clears handlers, sets `_promiseId = -1` (invalidates)

DEBUG: handler wrapped in 1ms timeout to catch "stop on caught exception" (L196-231).

Editor: random throttle 0-15 frames (L57-58) simulates async.

## Delay

`engine/lib/assets/___system/delay.c.ts`:

```typescript
@editable delay: number
@editable ___stack: debug ref (EDITOR)
```

`static delay(callback, delayFrames, container?): Delay` L37-66:
- **If `delayFrames <= 0`: executes callback synchronously in factory** (L42-45)
- Pool.create(Delay), adds to container's children
- EDITOR: stores name, captures stack trace
- Returns Delay instance

Instance methods:
- `skip()` L92-96: force execute callback immediately, removes self
- Constructor asserts no args (use `Delay.delay()` factory)
- `visible = false`

`update()` L98-107:
- Decrement `delay`
- When `delay < 1`: invoke callback, remove self
- EDITOR: warns if removed without execution (L78-80)

## Timeline editor (editor-side)

`thing-editor/src/editor/ui/props-editor/props-editors/timeline/`:

- **timeline.ts** — main timeline component
- **timeline-keyframe-view.ts** — draggable keyframe marker (right-click delete, drag horizontal)
- **timeline-label-view.ts** — draggable label, double-click rename, right-click delete
- **timeline-line-view.ts** — visual chart per field
- **timeline-loop-point.ts** — draggable loop indicator at `keyFrame.j`
- **time-marker.ts** — playhead
- **timeline-select-frame.ts** — drag-rectangle multi-select
- **objects-timeline.ts** — per-MovieClip view
- **timeline-field.ts** — field track
- **timeline-field-controls.ts** — per-field controls
- **keyframe-property-editor.ts** — selected keyframe property panel (mode select, action, gravity, bouncing, speed, random, jump time)
- **timeline-editor.ts** — toggle button (Ctrl+L)
- **get-keyframe-types-for-field.ts** — mode validator
- **timeline-selectable.ts** — interface

Keyframe edit flow:
1. Click keyframe → setState selected
2. KeyframePropertyEditor renders mode/action/gravity/bounce/speed/random/jump editors
3. Edit action → CallbackEditor picker
4. Edit mode → SelectEditor with READABLE_KEYFRAME_TYPES
5. `onKeyframeChanged()` → `___view.onChanged()`
6. `Timeline.allFieldDataChanged()` invalidates field caches
7. `MovieClip._disposePlayers()` clears field players
8. `game.editor.sceneModified()` flags dirty

Copy/paste keyframes via `Timeline.copySelection()` / `pasteSelection()` (L143-237).

Auto-keyframe: editing a property on selected MovieClip while timeline open auto-creates keyframe at playhead.
