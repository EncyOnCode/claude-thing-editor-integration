# Runtime: game.ts singleton

`thing-editor/src/engine/game.ts` (~1693 lines)

## Initialization flow

`game.init(element?, gameId?, pixiOptions?)` (L184-248):
1. NOT-EDITOR L186-189: applies `preloaderAssets.projectDesc` from `.tmp/assets-preloader`
2. L192-193: `new GameThemes()`, `new ResizeAttribute()`
3. L195: emits `'game-will-init'` window event
4. L197-198: Lib registers EMPTY + WHITE textures
5. L200: `new Application(pixiOptions)` → `this.pixiApp = app`
6. L202: appends `app.view` to DOM
7. L209: `new Settings(gameId)` → `game.settings`
8. EDITOR L212-215: applies enforced orientation from editor settings
9. L217: `initGameInteraction()` (pointer listeners)
10. L219: `app.stage.addChild(stage)` (stage = standalone Container named 'stage')
11. NOT-EDITOR L221-239: async loads `.tmp/classes`, Spine, preloaderAssets, fonts → `_startGame()`
12. L241-247: language-change listener calls `_onRenderResize` on all children

`_startGame()` runtime-only (L259-279):
- asserts NOT editor (L260-262)
- Texture.WHITE workaround (L267, BGG-6807/pixijs#8315)
- mobile orientation override (L269-271)
- wheel preventDefault listener (L273)
- window resize listener (L274)
- emits `'preloader-scene-will-start'`
- `showScene(getPreloaderSceneName())`
- preloader name: `projectDesc.scenes[0]` || `projectDesc.preloadScene` || 'preloader' (L1207)

## Pixi config

`applyProjectDesc()` L327-340:
- `BaseTexture.defaultOptions.mipmap = MIPMAP_MODES.ON|OFF` from projectDesc.mipmap
- `TextureGCSystem.defaultMode = GC_MODES.MANUAL` (no auto GC)

Canvas mode detection L539: `game.isCanvasMode = !(renderer as any).gl`
WebGL max texture size clamp L541-554: gets `MAX_TEXTURE_SIZE`, clamps scale

## Scene/modal/fader stacks (CRITICAL)

Module-level state:
```
scenesStack: (Scene | string)[] = []           // L46
modals: Container[] = []                        // L42
hidingModals: Container[] = []                  // L42
currentFader: Container | undefined             // L48
hidingFaders: Container[] = []                  // L49
hideTheseModalsUnderFader: Container[]          // L46
_isWaitingToHideFader: boolean                  // L133
```

**Scene operations:**
- `showScene(scene, faderType?)` L957-968: pushes, EDITOR clears stack first, calls `_startFaderIfNeed`
- `replaceScene(scene?, faderType?)` L1001-1017: pops + pushes
- `closeCurrentScene(faderType?)` L1052-1062: pops, asserts stack > 1 in EDITOR
- `closeAllScenes(faderType?)` L1064-1068: pops until 1
- `_startFaderIfNeed(faderType?)` L1019-1050:
  - if top != currentScene: `hideTheseModalsUnderFader = modals.slice()`
  - asserts `!_isWaitingToHideFader` if creating new fader
  - resolves faderType: scene.faderType || DEFAULT_FADER_NAME ('fader/default')
  - loads fader prefab, adds to stage
- `_setCurrentSceneContent(scene)` L1323-1352: asserts no current scene, adds at index 0, scene.interactiveChildren=false

**Modal operations:**
- `showModal(container|prefabName, callback?)` L1076-1108:
  - asserts NOT Scene (L1090)
  - asserts NOT editor mode unless __noAssertEditorMode override (L1082-1084)
  - pushes to modals, sets interactiveChildren=false, adds to stage
  - if callback: creates SceneLinkedPromise child named 'modal-promise-awaiter'
- `hideModal(container?, instantly?)` L1110-1155:
  - resolves 'modal-promise-awaiter' child promise
  - if instantly OR editor: destroy now; else move to hidingModals + fade out
- `currentContainer` getter L696-701: top modal || currentScene

**Fader flow:**
- `faderShoot()` L1166-1185 (called from fader's update when at peak):
  - destroys `hideTheseModalsUnderFader` items + `hidingModals`
  - sets `_isWaitingToHideFader = true`
- Update loop L817-841: if waiting AND `loadingsFinished === loadingsInProgress`:
  - `_processScenesStack()` (drains pending scene swaps)
  - calls scene.onShow()
  - `_hideCurrentFaderAndStartScene()` L916-927: `gotoLabelRecursive('hide fader')`, moves to hidingFaders
- `faderEnd()` L1187-1198: removes from hidingFaders, destroys
- Hiding modals fade at -0.1/frame, destroyed when alpha ≤ 0.01 (L893-905)
- Modals don't fade if `currentFader` present (L878)

## Ticker / update loop

`_updateGlobal(dt)` L712-783 — added to ticker in `_setClasses` L253:
- DEBUG L713-720: FPS tracking, increments `_FPS`, every 1000ms sets `FPS = _FPS`
- if !paused OR oneStep AND !editor:
  - emits `'global-update'`
  - dt capped to FRAME_PERIOD_LIMIT (4.0) and 1.0 in editor (L736-739)
  - accumulates `frameCounterTime`
  - while `frameCounterTime > FRAME_PERIOD`:
    - DEBUG: subtracts `FRAME_PERIOD * ticker.speed` (accounts for ticker.speed)
    - sets `isUpdateBeforeRender = !(frameCounterTime > FRAME_PERIOD)` (true on last iteration)
    - `_updateFrame()`
    - if oneStep: editor refresh, clear
- sets `currentScene.interactiveChildren` based on modal/fader presence (L769)

`_updateFrame()` L785-910:
- EDITOR: `__time++`, loadingProgress = time/3 for preloader
- WebGL context loss detection: reload after 60 frames if lost (L802-813)
- emits `'update'`
- fader wait + scene setup logic L817-869
- `currentContainer.update()`
- `currentFader?.update()` + `hidingFaders[*].update()`
- hidingModals fade (only if no currentFader)
- `Keys.update()` (drains keyup queue)
- emits `'updated'`

## Resize logic

`onResize()` L350-653:
- gets body size, resolves orientation (auto → portrait/landscape based on aspect)
- sets `game.isPortrait`, `game.isLandscapeMobile`
- canvas rotation: only mobile + fixed orientation
- W/H from projectDesc portrait/landscape dims
- scale calc by scaleMode ('contain'/'expand')
- EDITOR: scale=1 if not fullscreen, 1/16 if buildProjectAndExit
- clamps to WebGL max texture size
- dynamic stage size adjusts W/H
- centers canvas in body L634-645
- emits `'stage-will-resize'`
- calls `forAllChildrenEverywhere(processOnResize)` → invokes `_onRenderResize()` on children that have it

`onResize` called with delays L283: `[1, 20, 40, 80, 200, 500, 1000, 1500, 2000, 3000]ms` to catch cascading resizes.

## Loading gate

```
loadingsInProgress: number     // L147
loadingsFinished: number       // L148
loadingProgress: 0-100         // L149
loadingsInProgressOwners: Set  // L56 (DEBUG)
```

- `loadingAdd(owner)` L970-983: DEBUG asserts owner unique; if `finished===inProgress` resets both; increments inProgress
- `loadingRemove(owner)` L990-999: DEBUG removes from set; increments finished
- `_refreshLoadingProgress()` L985-988: floor(finished/inProgress * 100), asserts 0-100
- Preloader: `loadingProgress = Math.round(Math.min(100, game.time / 3))` L794
- Fader hide BLOCKED until `loadingsFinished === loadingsInProgress` L818

## Font loading

L1450-1510:
- if `projectDesc.webfontloader.custom.families.length`:
  - injects `@font-face` CSS with paths `fonts/{family}.woff2` + `fonts/{family}.woff`
  - strips spaces from family names
- if `.google.families.length`:
  - inserts `<link href="https://fonts.googleapis.com/css?family={family}">`
- `loadingAdd('FontsLoading')` before, `loadingRemove` after
- Optional `fontHolderText` creates invisible span to verify rendering

## Public API surface

Properties: W, H, data, Sound, projectDesc, all, classes, pixiApp, stage, settings, fullscreen, isCanvasMode, isVisible, isFocused, isMobile, isPortrait, isLandscapeMobile, _isCanvasRotated, _isWaitingToHideFader, mouse, isUpdateBeforeRender, keys, L, exitApp (Cordova), loadingProgress, FPS (DEBUG), currentScene (getter), currentContainer (getter), currentFader (getter), disableAllButtons (getter = currentFader exists).

Methods: init, onResize, addAssets, applyProjectDesc, showScene, replaceScene, closeCurrentScene, closeAllScenes, showModal, hideModal, showQuestion, forAllChildrenEverywhere, forAllChildrenEverywhereBack, faderShoot, faderEnd, openUrl, getPreloaderSceneName, showLoadingError, loadingAdd, loadingRemove, setValueByPath, applyCSS, __togglePause (DEBUG), __oneStep (DEBUG), _setClasses, _startGame, _setCurrentScene, _setCurrentSceneContent, _processScenesStack, _hideCurrentFaderAndStartScene, _startFaderIfNeed, _reloadGame (shows final-fader if exists).

EDITOR-only methods: __setCurrentContainerContent, __destroyCurrentScene, __setFixedViewport, __clearStage, _getScenesStack, __showDebugError, _reanimateTicker.

EDITOR-only properties: __EDITOR_mode, editor, __mouse_EDITOR, __mouse_uncropped, __enforcedOrientation, __enforcedW/H, __fixedViewport, __modalsCount, __doOneStep, __paused, __time.

## Events (window-level + game-level)

- `'game-will-init'` — before app.init
- `'stage-will-resize'` — onResize start
- `'preloader-scene-will-start'`
- `'global-update'` — before frame logic
- `'update'` — during frame logic
- `'updated'` — after frame logic (isUpdateBeforeRender true on last iter of batch)
- `'mainSceneLoaded'`
- `'onSoundsLoaded'`
- `'onLODUpgradeComplete'`
- `'onLanguageChanged'` [languageId]
- `'onThemeChanged'` [themeId]
- `'__sound-overridden'` (EDITOR) [soundId]

## Critical asserts/invariants

- L260: `_startGame()` NOT in editor
- L329: projectDesc only set once
- L930: no loading during `_processScenesStack`
- L1012: scenesStack not empty in replaceScene
- L1032: `!_isWaitingToHideFader` when starting new fader
- L1168: faderShoot called from fader update only
- L1169: faderShoot called once per fader
- Scene.interactiveChildren forced false if ANY fader OR ANY modal (L769)
- WebGL context loss: 60-frame delay before reload, only if WebGL + visible (L802-813)
