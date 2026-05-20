# Editor architecture (Preact UI + Electron bridge)

## Entry & singleton

`thing-editor/src/editor/editor.ts` (~1280 lines):

`new Editor()` constructor L142-188:
- Parse CLI args into `editorArguments: KeyedMap<true | string>` (`--key=value` syntax)
- Assign to `game.editor` global
- Mute sound, build-mode setup if `--build-and-exit`
- Render root UI component
- Bind methods

Public instance fields (L88-135):
```
LanguageView, LocalStoreView           // UI component classes
currentProjectDir, currentProjectAssetsDir, currentProjectAssetsDirRooted
assetsFolders, assetsFoldersReversed   // all dirs (project + libs)
libsDescriptors: KeyedMap<ProjectDesc>
editorArguments: KeyedMap<true | string>
projectDesc: ProjectDesc                // merged with libs
selection = new Selection()             // array-like Container list
settings: Settings                      // global non-project
settingsLocal: Settings                 // per-project
showGizmo, isSafeAreaVisible, disableFieldsCache, etc.
history = historyInstance
ui: UI                                  // mounted post-construction
__FatalError, restartInProgress, isProjectOpen
```

## Lifecycle

`onUIMounted(ui)` L190-231:
- GlobalConfigManager + ThemeManager init
- Load last project or show chooser
- `beforeunload` handler asks to save if modified
- 300ms interval updates UI if scene runs

`loadProject(dir?)` L351-523:
- Stop viewport, build paths
- Read `thing-project.json`
- For each lib: read `thing-lib.json`, optional `schema-thing-project.json`, merge descriptors
- Merge all configs, write merged schema
- `game.applyProjectDesc(projectDesc)`, `game.init()`
- Load Spine runtime
- Load wrong-texture, reload assets/classes
- Restore or pick last scene
- Load fonts, await loading 100%
- Emit `firstSceneWillOpen`, restore backup if exists
- Regenerate prefab typings
- Watch asset folders
- Save recent projects

`openProject(dir)` L332-338: asks to save, sets `restartInProgress=true`, reloads window.

`openScene(name)` L616-639: ask to save, reset Pool ID, `game.showScene(name)`, expand root, save selection.

`saveCurrentScene(name?)` L763-779: stop viewport, history unmodified, `_callInPortraitMode()`, `Lib.__saveScene()`, save selection, validate resources.

`reloadClasses()` L243-262: spinner, save state, `emit('willClassesReload')`, ClassesLoader.reloadClasses(), restore backup, `emit('didClassesReloaded')`.

## Editor public API (key methods)

- `editProperty(field, val, delta?)` L294-314 — single/batch edit, calls beforeEdited/afterEdited hooks
- `onObjectsPropertyChanged(o, field, val, isDelta?)` L933-976 — apply change, emit events, invalidate caches
- `addTo(parent, child)` L673-684 — add node, unhide ancestors, init if game running, select
- `isCanBeAddedAsChild(Class, parent?)` L686-706 — checks __canAcceptParent + __canAcceptChild
- `chooseImage/Sound/Prefab/Scene/Class(...)` L854-874 — asset pickers
- `chooseAsset(type, title, current?, onPreview?, filter?, idSuffix?)` L882-909
- `validateResources()` L754-761 — validates all prefabs+scenes
- `shiftObject(o, dX, dY)` L815-833 — arrow-key movement
- `moveContainerWithoutChildren(o, dX, dY)` L797-813 — move parent only, reposition children
- `editSource(fileName, line?, char?, absolutePath?)` L1012-1032 — open in VSCode via fetch `/__open-in-editor`
- `copyToClipboard(text)` L1006-1010
- `previewSound(soundName)` L835-846 — toggle play
- `askSceneToSaveIfNeed()` L647-671 — boolean (false = cancel)
- `chooseAssetsFolder(title, activeFolder?)` L1074-1093
- `reloadClasses()`, `classesUpdatedExternally()`, `pauseGame()`, `buildProjectAndExit` getter
- `isCurrentSceneModified/isCurrentContainerModified` getters → `history.isStateModified`
- Toggle methods: `toggleScreenOrientation`, `toggleIsMobileAny`, `toggleSafeAreaFrame`, `toggleHideHelpers`, `toggleSoundMute`, `toggleVSCodeExcluding`, `toggleShowSystemAssets`

`__saveProjectDescriptorInner()` L1101-1182 — strips per-lib defaults from project descriptor before write.

`excludeOtherProjects()` L1193-1285 — conditionally rewrites VSCode workspace + tsconfig to include only current project.

## fs.ts (Electron IPC bridge)

`thing-editor/src/editor/fs.ts`:

Bridge functions L150-161:
- `execFs(command, filename?, content?, ...args)` — sync via `electron_ThingEditorServer.fs()`
- `execFsAsync()` — async via `electron_ThingEditorServer.fsAsync()`
- Throws on Error return, shows modal

40+ public methods (full list):
1. `addSubAsset(file)`, `removeSubAsset(name, type)`
2. `browseDir(path)`, `showFile(filename)`
3. `build(projectDir, debug, copyAssets, projectDesc): Promise`
4. `copyAssetToProject(file)`, `copyFile(from, to)`, `deleteAsset(name, type)`, `deleteFile(filename)`
5. `enumProjects(): ProjectDesc[]`, `exists(filename): bool`, `exitWithResult(success?, error?)`
6. `fieldsFilter(key, value)` — strips `___*` keys (used in JSON.stringify replacer)
7. `getArgs(): string[]`, `getAssetsList(type?): FileDesc[]`, `getFileByAssetName(name, type)`, `getFileHash(filename)`, `getFileOfRoot(object)`, `getFolderAssets(dirName)`, `getWrongSymbol(filename)` (regex `/[^@a-zA-Z_\-\.\d\/]/`)
8. `isFilesEqual(file1, file2)`, `log(message)`
9. `moveAssetToFolder(file, lib)`, `openDevTools()`
10. `parseJSON(src, filename)`, `readDir(path)`, `readFile(filename)`, `readFileIfExists(filename)`, `readJSONFile(filename)`, `readJSONFileIfExists(filename)`
11. `rebuildSounds(dir)`, `rebuildSoundsIfNeed(file)`, `refreshAssetsList(dirNames?)`, `renameAsset(file)`
12. `run(script, ...args): Promise` — executes Node module with args, shows spinner
13. `saveAsset(name, type, data, libName?, doNotSetFileAsset?)`, `setProgressBar(progress, operationName?)`
14. `showQuestion(title, message, yes, no, cancel?): number`, `watchDirs(dirs)`, `writeFile(filename, data, separator?): mtime`

`AssetType` enum L68-78: IMAGE, SOUND, SCENE, PREFAB, CLASS, RESOURCE, BITMAP_FONT, L10N, FONT

Extension map L99-113:
- `.png/.jpg/.svg/.webp` → IMAGE
- `.s.json` → SCENE (7-char ext)
- `.p.json` → PREFAB (7)
- `.l.json` → L10N (7)
- `.json` → RESOURCE (5)
- `.woff/.woff2` → FONT
- `.wav` → SOUND
- `.xml` → BITMAP_FONT
- `.c.ts` → CLASS (5)

Asset watching L171-190:
- Receives `fs/change` IPC events
- Debounced 330ms
- `.ts` changes → `classesUpdatedExternally()`
- Other → `refreshAssetsList()`
- Ignored files cleared after 500ms

## classes-loader.ts

L36-251 `reloadClasses()`:
- Get all CLASS assets via `fs.getAssetsList(AssetType.CLASS)`
- Map files to dynamic imports
- For each class:
  - Validate extends DisplayObject
  - Fix class name (strip leading underscores if mismatched filename)
  - Set `__className`, `__classAsset`, `__sourceFileName`, `__defaultValues={}`
  - Detect Scene subclass via `instance instanceof Scene`
  - Process `__editablePropsRaw` (auto-detect type, mark `___*` non-serializable, NaN wrap)
  - Validate min/max/step
  - Inject splitter header
- Inheritance merging (walks `__proto__`)
- Sets `__EDITOR_icon` ('tree/movie-custom' for MovieClip, 'tree/game' default)
- Calls `regenerateClassesTypings()`

Dynamic import wrapper (L255-261): appends `?v=componentsVersion` for cache busting (except engine lib).

## Selection (`utils/selection.ts`)

`class Selection extends Array<Container>` L50.

Static OutlineFilter L11-32:
- White, 2px outline, 1px padding
- 300ms interval animates alpha 0→0.3 based on gizmo visibility
- ParticleSystem filters disabled (thickness=0)

Methods:
- `select(o, add?, callback?, scrollInView?)` L52-67 — clear unless add, toggle if already selected, sort by depth
- `add(o, scrollInView?)` L74-120 — check `getParentWhichHideChildren(o, true)`, prompt to edit prefab if inside one, add outline filter, push, schedule save
- `remove(o)` L122-138 — exit preview mode, remove filter, splice, schedule save, `__onUnselect()`
- `clearSelection(refreshUI?)` L157-165
- `saveSelection(): SelectionData` L140-142
- `loadSelection(data)` L144-155 — sets `IS_SELECTION_LOADING_TIME=true` to suppress saves

```typescript
interface SelectionPathEntry { n: string | null; i: number; }
type SelectionPath = SelectionPathEntry[];
interface SelectionData extends SelectionDataBase {
  _stageX?: number;
  _stageY?: number;
  _stageS?: number;
}
```

`saveCurrentSelection()` L167-169 — to `settingsLocal[__EDITOR_scene_selection{sceneName}]`
`loadCurrentSelection()` L171-173

Helpers L176-226:
- `getPathOfNode(node)` walks to game.stage, finds siblings with same name & index
- `selectNodeByPath(path)` walks from root following path
- `recalculateNodesDeepness()` DFS assigns `__nodeExtendData.deepness`
- `sortByDeepness()`, `sortSelectedNodes()` — maintain tree order

## History (`utils/history.ts`)

`undoStack: KeyedMap<HistoryRecord[]>` (per scene/prefab) L17
`redosStack: KeyedMap<HistoryRecord[]>`

Constants:
- HISTORY_LEN = 100
- STRICT_HISTORY_LEN = 20

```typescript
interface HistoryRecord {
  treeData: HistorySerializedData;  // full scene serialization
  fieldName: string | null;          // last edited field
  selectionData: SelectionData;
}
```

Key: `s/{sceneName}` or `p/{prefabName}` (from `getHistoryName()` L54-66).

Methods:
- `_sceneModifiedInner(saveImmediately?)` L103-111 — sets needHistorySave
- `scheduleHistorySave()` L113-120 — debounce 1ms
- `scheduleSelectionSave()` L122-129 — 50ms (suppressed during STATE_APPLY_TIME)
- `saveHistoryNow()` L131-142
- `isUndoAvailable()`/`isRedoAvailable()` L144-152
- `_pushCurrentStateToUndoHistory(selectionData, selectionOnly?)` L176-207:
  - serialize `game.currentContainer` to treeData
  - **Pruning**: keep [0..STRICT_HISTORY_LEN], then every-other beyond
- `addSelectionHistoryState()`/`addHistoryState(selectionOnly?)` L209-224
- `undo()`/`redo()` L226-244 — apply state, select field if any
- `currentState` getter L246-253
- `setCurrentStateModified()`/`setCurrentStateUnmodified()` L256-268
- `isStateModified` getter L270-272
- `navigateSelection(direction)` L274-295 — skip same-selection states

`applyState(state)` L29-52:
- Sets `STATE_APPLY_TIME = true`
- If treeData changed: emit `beforeHistoryJump`, reset pool, deserialize, `game.__setCurrentContainerContent(node)`
- Load selection, restore stage position/scale
- Update `lastAppliedTreeData`
- Emit `afterHistoryJump` if changed

Hotkey bindings L338-365:
- Ctrl+Z undo, Ctrl+Y redo
- Ctrl+Alt+Left/Right selection nav

## PrefabEditor (`utils/prefab-editor.ts`)

`prefabsStack: PrefabEditState[]` — nested prefab editing.

Methods:
- `editPrefab(name, isItStepInToStack)` L33-52 — validates, loads, swaps stage, pushes stack
- `showPreview(object)` L83-112 — backdrop, restore settings (bg color, x/y, scale), save selection
- `hidePreview()` L116-130 — detach backdrop, restore viewport, reload selection
- `acceptPrefabEdition(oneStepOnly)` L136-162 — `checkPrefabReferenceForLoops`, `Lib.__savePrefab()`, refresh refs, regenerate typings
- `exitPrefabEdit(oneStepOnly)` L182-197 — pop stack
- `checkPrefabReferenceForLoops()` L164-180 — recursive, error code 99999
- Per-prefab settings stored in `settingsLocal['prefab-settings'+name]`
- `pivot` getter/setter — 'left-top', 'center', etc.
- `applyGridPos()` adjusts backdrop position

**Unreference action** (tree-node-context-menu.ts L231-244):
```typescript
delete o.__nodeExtendData.isPrefabReference;
for (const c of o.children) {
  delete c.__nodeExtendData.hidden;
}
Lib.__invalidateSerializationCache(o);
```

## Props Editor (`ui/props-editor/props-editor.ts`)

`class PropsEditor extends ComponentDebounced` L13.

Static registration L412-431 maps EditablePropertyType → renderer component.

`registerRenderer(type, render, def)` L85-89 — static, asserts uniqueness.

Render flow L246-407:
- No selection → "Nothing selected"
- Multi-select intersection: keeps props visible on ALL selected (L283-304)
- Mark disabled if not all have OR disabled() returns truthy (stores reason)
- Group by splitter (L330-340), render via `group.renderGroup()`
- Renders PropsFieldWrapper per prop

Header L347-402:
- Non-prefab: class icon + button (changes class)
- Mixed types indicator
- Prefab references: prefab name + button (changes prefab)
- Unknown constructor/prefab warning (red)
- "Edit prefab" button (Ctrl+E)

`onChangeClassClick()` L156-199 — opens class selector, deserializes with new class
`onChangePrefabClick()` L120-154 — changes prefab ref, handles MovieClip property migrations
`selectField(fieldName, focus?, selectAll?, fieldArrayItemNumber?)` L201-244

## PropsFieldWrapper (`ui/props-editor/props-field-wrapper.ts`)

Wraps single property editor with label + context menu + defaults display.

`onChange(val, isDelta?, deltaVal?)` L276-315:
1. `field.parser(val)` if exists
2. `field.renderer.parser(val)` if exists
3. Min/max clamp

Context menu L49-242:
- Copy/paste value, copy/paste HEX (colors)
- Copy property name
- Why disabled? (show reason)
- Insert/move array items
- Reset to default
- Go to property definition (opens `__src`)
- Custom `field.renderer.contextMenuInjection` (e.g., "Reveal in Explorer" for image/sound)

## Per-type renderers

`ui/props-editor/props-editors/`:

**NumberEditor** — text input + up/down arrows (drag with pointer lock, Ctrl=10x), keyboard arrows, basis for hex/octal, expression eval support, step/min/max enforcement.

**SliderEditor** — visual track + thumb, click anywhere to jump, step rounding, requires min/max (propertyAssert).

**StringEditor** — multiline via field.multiline, empty→null parser.

**SelectEditor** — dropdown via portal `#select-lists-root`, search filter (persists to settings), max 20 items.

**ColorEditor** — HTML5 `<input type="color">`, 24-bit hex int (0x000000-0xFFFFFF), padded #RRGGBB display.

**BooleanEditor** — checkbox.

**BtnProperty** — calls `field.onClick` on all selected.

**ImageEditor/SoundEditor/ResourceEditor/PrefabPropertyEditor** — picker dialog via `game.editor.chooseAsset()`, asset validation via `fs.getFileByAssetName()` (danger styling if missing), clear button, "Reveal in Explorer" context menu, prefab editor has "Edit prefab" (Ctrl+E).

**L10nEditor** — SelectEditor wrapping LanguageView.selectableList.

**RectEditor** — 4× NumberEditor (x,y,w,h), nullable, per-dimension min/max, rect guide visualization via `___RectGuide.show()`.

**RefFieldEditor** — read-only display, Container objects → clickable scene node; functions → JSON or modal.

**DataPathEditor** — hierarchical property browser, paths `'parent.object.property'`, `#childName` notation, `this`/`all` roots, parameter hints, breakpoint button, "Go to target".

Filters:
- Hides shadow `_x` if `x` exists
- Respects `___EDITOR_isHiddenForChooser` / `___EDITOR_isHiddenForDataChooser`
- `___EDITOR_isGoodForChooser` overrides heuristics

**CallbackEditor** extends DataPathEditor — filters to functions, ___EDITOR_isHiddenForCallbackChooser respected, parameter chooser via ___EDITOR_callbackParameterChooserFunction.

**PowDampPresetEditor** — SelectEditor with 13 presets (see authoring.md).

**CurvePropertyEditor** — button opens CurveEditor modal (canvas 600×480), keyframes (Linear=red, Smooth=teal, Discrete=yellow), drag/right-click delete/click to add (first+last fixed time).

**TimelineEditor** — toggle (Ctrl+L) opens floating window at position (0, 70) with Timeline component.

**SpineSequencesEditor** — toggle (Ctrl+L) opens SpineSequences window.

**ArrayEditableProperty** — wraps any renderer in array, add/remove buttons, defaultArrayItemValue.

## UI layout (`ui/ui.ts` ~150 lines)

```
┌─────────────────────────────────────────┐
│ MainMenu (File|Edit|Project|Assets|...) │
├──────┬────────────────────┬─────────────┤
│Scene │  PropsEditor       │  Viewport   │
│Tree  │  (17-51%)          │  (51-100%)  │
│(0-17%│                    │             │
├──────┴────────────────────┴─────────────┤
│ AssetsView Windows (0-100% y:70-100%)   │
├──────────────────────────────────────────┤
│ StatusBar (bottom-right)                │
└──────────────────────────────────────────┘
Modals/Context menus/Notifications float on top
```

Refs:
- `modal`, `viewport`, `sceneTree`, `propsEditor`, `status`

Default windows L187-244: Classes(0-20), Prefabs(20-40), Images(40-60), Sounds(60-80), Scenes(80-100) all y:70 h:30.

## Modal API (`ui/modal.ts`)

```typescript
showModal(content, title='', noEasyClose=false, toBottom=false): Promise<any>
showInfo(message, title, errorCode=99999): Promise<any>
showPrompt(title, defaultText?, filter?, accept?, noEasyClose?, multiline?): Promise<string | undefined>
showListChoose(title, list, noEasyClose?, noSearchField=false, activeValue?, doNotGroup=false): Promise<any>
notify(txt, hideId?): Promise<void>  // auto-hide 1200ms
showSpinner(): void
setSpinnerProgress(val, operationName?): void
hideSpinner(): void
showEditorQuestion(title, message, onYes, yesLabel='Ok', onNo?, noLabel='Cancel', noEasyClose=false): Promise<any>
showError(message, errorCode=99999, title='Error!', noEasyClose=false, toBottom=false): Promise<any>
showFatalError(message, errorCode, additionalText?): Promise<void>
```

Modal stack L16-21 — supports toBottom for unshift priority.
`hideModal()` pops + resolves promise.
ShowError pauses game if running (L255).

## Tree View (`ui/tree-view/tree-view.ts`)

`TreeView extends ComponentDebounced<_, TreeViewState>`.

Search filter (F3/Enter), drag/drop:
- MimeTypes:
  - `text/drag-thing-editor-class-id` (class)
  - `text/drag-thing-editor-prefab-name` (prefab)
  - `text/drag-thing-editor-tree-selection` (tree node)
- Drop modes (CSS classes): `drag-target-top|mid|bottom|wrap`
- Ctrl+drag = wrap mode
- Alt+drag = clone mode (tree-selection)
- Auto-expand collapsed nodes after 400ms hover

**Tree node click logic** (TreeNode.onClick L27-70):
- Right-edge click (within 40px) toggles `__nodeExtendData.childrenExpanded`
- Shift+click range select siblings
- Ctrl+click multi-select
- Alt+click recursively expand all children

**Context menu** TREE_NODE_CONTEXT_MENU L143-273:
- Copy/Cut/Paste/Paste Wrap, Clone
- Export as PNG
- Arrange submenu (z-order + position)
- Add submenu (game components)
- Change type, Go to Source
- Why invisible?
- Save as prefab, Unreference
- Isolate (Ctrl+I), Delete, Unwrap (Ctrl+Delete)

**Arrange submenu:** Bring top/move top, move bottom/bring bottom (Alt+arrows), shift position arrows ±1px (Ctrl=±10px).

## Status (`ui/status.ts`)

`Status extends ComponentDebounced` with errors[] + warns[] lists, WeakMaps for dedup by owner+field.

`error(message, errorCode?, owner?, fieldName?, fieldArrayItemNumber?)` L106-140:
- Adds + shows window
- **Pauses game** (L135) via `game.editor.pauseGame()`

`warn()` similar but non-blocking.

Error code → URL: L204-207 uses `Help.getUrlForError(errorCode)` → wiki page.

`StatusBar` (`ui/status-bar.ts`) — bottom-right floater showing mouse coords, local coords, zoom %, modification indicator (●), status entries (priority-ordered).

## Editor overlay & viewport input (`ui/editor-overlay.ts`)

`overlayLayer` Container holds gizmo. Loads `___system/gizmo` prefab at init.

Mouse handlers:
- Middle button drag: pan viewport
- Right button drag: move selected to mouse (Alt+ = clone first, Ctrl = without children)
- Left click: select via `selectByStageClick()` (cycles through stacked objects on repeat)
- Wheel: zoom around pointer (0.02× to 32×)

`selectByStageClick()` L177-234:
- Filters: `!__doNotSelectByClick && worldVisible && worldAlpha > 0 && containsPoint(mouse)`
- Respects `getParentWhichHideChildren()`
- Avoids stage contents if playing (unless Alt/Ctrl/Shift)

## Window system (`ui/editor-window.ts`)

`Window<P, S> extends ComponentDebounced` — draggable/resizable floating panel.

Props: id, x/y/w/h (% based), minW/minH (px, scales down if exceeded), content, title, helpId, onResize.

Static `Window.all: KeyedMap<Window>`, `Window.allOrdered: Window[]` (z-order, first = topmost).

Settings key `editor_window_state_{id}` (10ms debounce). Magnetic snap within 5px.

`CornerDragger` component for edge/corner resize. Neighbor draggers activated if holding Shift/Ctrl/Alt.

`bringWindowForward(windowBody, setCurrentHelp?)` L429-449 reorders z-index, sets help context.

## Main menu (`ui/main-menu.ts`)

MAIN_MENU array L148-506:
- **File**: Open project, Save scene/prefab, New scene, New component, Exit (Ctrl+W)
- **Edit**: empty (injection target)
- **Project**: Browse folder, Build, Game Theme, Switch theme, Local store, Localization, Language, Prefix, Project Properties
- **Assets**: Cloud Assets, Create/Edit Spritesheet, Create/Edit Bitmap Font, Low Quality Textures
- **Settings**: Mute (Ctrl+M), isMobile, Gizmo (Ctrl+H), Safe area (Ctrl+F), Editor theme, Show system assets, VSCode excluding, Dev tools, Reset layout

`injectMenu(targetMenuId, items, injectionId, pos?)` L511-546.

## Context menus (`ui/context-menu.ts`)

`ContextMenuItem`:
```typescript
{
  name: ComponentChild | () => ComponentChild,
  onClick?: (ev) => void,
  disabled?: () => boolean,
  hidden?: boolean,
  stayAfterClick?: boolean,
  tip?: string,
  hotkey?: Hotkey,
  submenu?: ContextMenuItem[] | () => ContextMenuItem[]
}
```

`showContextMenu(template, ev)`, `hideContextMenu()`, `toggleContextMenu()`, `refreshContextMenu()`.

Submenus position right of parent, auto-reposition off-screen. Hover delays: 150ms show, 300ms hide.

Root element: `#context-menu-root` (in index.html).

## Assets view (`ui/assets-view/`)

`AssetsView extends Window` — multi-window asset browser with persistence (SETTINGS_KEY `__EDITOR_assetsView_list`).

Type filters (every AssetType toggle) + library filters (project + libs).

Per-type renderers in `asset-view-{type}.ts`:
- **Class**: icon + name, drag mime `class-id`, context: Child/Place/Wrap/Copy name/Source/Create prefab/Move to lib/Delete, Find buttons (Ctrl=any, Alt=strict type)
- **Image**: thumbnail + name (hover preview), "Assign to property" dynamic context menu, Move/Delete
- **Scene**: class icon + name, click=edit, dblclick=class source, New scene/Save as/Source/Move/Delete
- **Sound**: name + bitrate ("X kbps" or default), click=preview, Bitrate submenu (8-256), Move/Delete
- **Prefab**: class icon + name + first line of description, drag mime `prefab-name`, Child/Place/Wrap/Duplicate/Inherit/Copy name/Source/Move/Delete, Alt+click=child, click=edit prefab
- **Font/L10N/Resource**: simple display

Search filtering:
- Class searches `__className`
- Prefab searches name + description + parent prefab hierarchy
- Others search assetName

System assets (starting `___` or `/___`) hidden unless toggle.

## Cloud assets dialog (`ui/cloud-assets-dialog.ts` ~677 lines)

State: `cloudAssetsUrl`, `cloudAssetKeys: KeyedMap<string>`, `hasChanges`, `loadedAssets: Map<string, CloudAssetData>`, etc.

UI sections:
1. URL config + "Sync Cloud Assets" → `AssetsResolve.getInstance().initCloudAssets(url)`
2. Key Mappings table: Cloud Key (input) → Local Asset (select with search), Add/Delete
3. Loaded Assets Preview: grouped by type (Images/Sprite Sheets/Spine/UI/Locales), click to select, language detection from key suffix

`onSave()`: writes to projectDesc, calls `fs.saveProjectDesc()`.

## Project properties dialog (`ui/project-properties-dialog.ts` 449 lines)

4 tabs: General, Display, Localization, Audio.

**General**: title, id, version, defaultLanguage, mainScene (select), preloadScene (select).
**Display**: screenOrientation enum, width/height, portraitWidth/Height, dynamicStageSize, preventUpscale.
**Localization**: embedLocales, __localesNewKeysPrefix, GlobalVariablesTableEditor.
**Audio**: defaultMusVol, defaultSoundsVol, soundDefaultBitrate (preset), soundFormats[].

`onSave()`: `Object.assign(game.editor.projectDesc, state.projectDesc)` + `saveProjectDesc()`.
"Edit JSON directly" opens thing-project.json in editor.

## Spritesheet editor dialog (`ui/spritesheet-editor-dialog.ts` 960 lines)

Visual spritesheet frame editor:
- Sprite list (left) with search
- Canvas (center) with checkered bg, sprite outlines (selection blue, hover yellow, normal teal)
- Property editor (right): X, Y, W, H, sourceSize (read-only), export format, quality
- Footer: controls + Save

Interaction: left-click drag move, corner drag resize, Alt+drag/middle pan, scroll zoom (0.1-10x).

Export: single sprite or all filtered → `assets/img/exported-sprites/`. Preserves trimming metadata.

## Language view (`ui/language-view.ts` 687 lines)

Table editor: rows=keys, columns=languages.
- Add key, add language, show/hide preview (with global variables substitution), directory select
- Cell editing: textarea per language per key
- Key name click=search, Ctrl+click=copy, dblclick=rename, right-click=delete
- Auto-creates `.l.json` files for new languages (unless `__doNotAutoCreateLocalizationFiles`)

`__validateTextData()` checks template placeholders consistency across languages.

Key naming: `/^[a-zA-Z0-9_./]+$/`, no leading/trailing dot, no duplicates.

Flattens nested: `ui.button.label` → `{ui: {button: {label: ''}}}`.

## Local store view (`ui/local-store-view.ts` 108 lines)

Debug localStorage: search input, key|value|delete rows, Clear button with confirmation.
Ctrl+click on key/value copies to clipboard.

## Help system (`ui/help.ts` 60 lines)

URL root: `https://github.com/Megabyteceer/thing-editor/wiki/`

`Help.getUrlForError(code)` → `root + 'Error-Messages#' + code`

F1 opens `latestClickedHelpURL` (tracked via mouse events + `data-help` attribute).

If URL has no http: prepend root.

## EDITOR_FLAGS (`utils/flags.ts`)

```typescript
EDITOR_BACKUP_PREFIX = '___editor_backup_'  // L9

class EDITOR_FLAGS {
  static _root_initCalled: Set<Container>            // L13 - validates super.init()
  static _root_onRemovedCalled: Set<Container>       // L15 - validates super.onRemove()
  static updateInProgress: boolean                    // L17 - exception in update() flag
  static isolationEnabled: boolean                    // L19
  static isTryTime: number                            // L21 - try-catch counter
  static isStoppingTime: boolean                      // L23
  static checkTimeOut: number                         // L25 - timeout ID
  static rememberTryTime() { ... }                    // L27-35
  static checkTryTime() { ... }                       // L37-45
}
```

`rememberTryTime/checkTryTime` detect "stop on caught exception" debugger setting — warns if >1s elapsed.

## Isolation mode (`ui/isolation.ts`)

- `toggleIsolation()` L6-12 — switches `EDITOR_FLAGS.isolationEnabled`
- `isolateSelected()` L14-31 — marks all objects `isolate=true`, then recursively unmarks selected + ancestors
- `exitIsolation()` L33-39 — unmarks all

Uses `__nodeExtendData.isolate = true` to hide objects.

## Preview mode (editor-utils.ts L62-74)

- `goToPreviewMode(o)` — calls `o.__goToPreviewMode!()`, subscribes to `beforePropertyChanged`
- `exitPreviewMode(o)` — calls `o.__exitPreviewMode!()`, unsubscribes
- Sets `o.__nodeExtendData.__isPreviewMode`

Preview exits automatically on property change.

## Editor events (`utils/editor-events.ts` 47 lines)

`editorEvents` = TypedEventEmitter:

| Event | Payload |
|-------|---------|
| `playToggle` | () |
| `projectDidOpen` | () |
| `beforePropertyChanged` | (o, fieldName, field, val, isDelta?) |
| `afterPropertyChanged` | (o, fieldName, field, val, isDelta?) |
| `willClassesReload` / `didClassesReloaded` | () |
| `gameWillBeInitialized` | () |
| `firstSceneWillOpen` | () |
| `sceneWillOpen` / `sceneDidOpen` | (name) |
| `sceneWillDestroy` / `sceneDidDestroy` | (name) |
| `assetsRefreshed` | () |
| `soundPlay` | (soundId, volume) |

**Warning** L22-42: handlers added multiple times on class reload — use flag in global object to add once.

## Theme manager (`utils/theme-manager.ts`)

Singleton, localStorage key `'editor-theme'`, default `'light'`.

CSS files per theme L12: `['style.css', 'style-timeline.css', 'style-spine-sequence.css', 'game-theme-editor.css']`

`applyTheme()` L173-192:
- Creates `<link rel="stylesheet" data-theme={name}>` for each CSS file
- Appends to document.head

`removeCurrentThemeStyles()` removes by `data-theme` attribute.

Themes available in `thing-editor/src/editor/themes/`: dark/, light/, pink/.

## Generated typings (`utils/generate-editor-typings.ts`)

`regenerateCurrentSceneMapTypings()` L15-84 → `/thing-editor/src/editor/current-scene-typings.d.ts`:
```typescript
declare global {
  type CurrentSceneType = Main;
  interface ThingSceneAllMap {
    [key: string]: Container;
    'objectName1': ClassName1;
    // @deprecated Refused because 17 objects with that name...
    'duplicate': DSprite;
  }
}
```

`regeneratePrefabsTypings()` L130-180 → `/thing-editor/src/editor/prefabs-typing.ts`:
```typescript
export default class TLib {
  static loadPrefab(prefabName: 'fader/default'): Container;
  static loadPrefab(prefabName: 'final-fader'): MovieClip;
  static loadPrefab(prefabName: string): Container;  // fallback
}
```

`regenerateClassesTypings()` L87-126 → `/thing-editor/src/editor/current-classes-typings.d.ts`:
```typescript
declare global {
  interface GameClasses {
    [key: string]: SourceMappedConstructor;
    'ClassName': typeof ClassName;
  }
}
```

`regenerateLocalizationTypings()` → `localization-typings.d.ts`:
```typescript
interface LocalizationKeys {
  (id: 'ui.take', values?: KeyedObject | number): string;
  // overload per key
}
```

Caching: `__currentAllMap`, `__currentClassesMap`, `__currentPrefabsMap` JSON strings detect changes. Skips if `--no-vscode-integration` flag.

## Editor settings keys (catalog)

UI state: safe-area-frame, show-gizmo, sound-muted, vs-code-excluding, show-system-assets, isMobile.any, viewportMode, speed
Panels: sound-profiler-shown, labels-logger-shown, editor_window_state_{id}, _sound-debugger-shown, data-access-debugger-shown, timeline-showed
Clipboard: __EDITOR-clipboard-data, __EDITOR-clipboard-data-text-style, __EDITOR-clipboard-data-timeline, __EDITOR-clipboard-data-timeline-name
Search: tree-view-search, projects-filter, props-editor-scroll-y, {filterName} per select
Zoom: timeline-height-zoom, timeline-width-zoom
Sound panel: __sounds-panel-is-left, __sounds-panel-sort-by-time, __sounds-panel-sort-by-name
Game settings: soundEnabled, musicEnabled (in game.settings)
Misc: tip-discard-{tipId}, debug-data-access, prefab-settings{prefabName}, created-components, THEME_STORAGE_KEY

## Common editor utils (`utils/editor-utils.ts` ~705 lines)

`editorUtils` namespace, 30+ operations:
- deleteSelected, clone, wrap, wrapSelected, cut, copy, paste, pasteWrap, moveUp/Down, bringUp/Down, savePrefab, centralizeObjectToContent, findInvisibleParent, isCanBeUnwrapped, exportAsPng, preCacheImages, goToPreviewMode, exitPreviewMode

Clipboard L694-704: `editor.settings['__EDITOR-clipboard-data']` persistent.

## Other utils

- `data-path-fixer.ts` (340 lines) — auto-corrects paths after node rename/move via 5 repair strategies (rename, remove segment, insert 'parent', insert changed name)
- `old-references-detect.ts` (77 lines) — proxy-based dangling reference detection (error 10048)
- `get-prefab-defaults.ts` (45 lines) — memoizes via `__prefabsDefaults` map, walks prefab `.r` chain
- `localization-validator.ts` (250 lines) — validates global variable names + values + usage
- `global-config-manager.ts` (328 lines) — singleton for global localization variables
- `stack-utils.ts` (84 lines) — `getCurrentStack(title)`, `showStack(stack)` with source map fetch
- `validation-serialized-data.ts` (164 lines) — recursive asset reference validation
- `enum-assets-recursive.ts` (98 lines) — collects assets referenced in object/prefab data
- `export-as-png.ts` (157 lines) — Container → PNG blob with alpha cropping
- `hotkey.ts` (51 lines) — `isHotkeyHit(ev, element, hotkey)`, `hotkeyToString(hotkey)`
- `project-version.ts` (296 lines) — parse, validate (`/^\d+\.\d+\.\d+/`), increment, generateBuildNumber (Unix ts), generateDateString (YYYYMMDD)
- `data-access-debugger.ts` (264 lines) — Proxy-based debugger on game.data with breakpoints
- `new-component-wizard.ts` (138 lines) — 4-template scaffold with auto-clean comments after 3+ components
- `button-only-selectable-property.ts` — restrict callback selector to onClick contexts

## Error code ranges

| Range | System | Examples |
|-------|--------|----------|
| 10000-19999 | Utilities | 10048 dangling reference |
| 30000-39999 | Paths/Selection/Prefabs | 30001-30023 |
| 32000-32999 | Property/Asset validation | 32037-32103 |
| 40000-49999 | Classes | 40004 property redefinition |
| 90000-90999 | Generic | 90001 default help |
| 99999 | Fallback | unspecified |

`Help.getUrlForError(<90000)` constructs URL; ≥90000 use default 'editor.Overview'.

## Warnings filter (`warnings-filter.ts`)

Suppresses `PixiJS Deprecation` warnings in console.warn/groupCollapsed, cascades to groupEnd.
Suppresses `[vite] connecting...` / `[vite] connected.` debug messages.

## preact-fabrics (`editor/preact-fabrics.ts`)

`class R extends BasicR` — extended factory with editor helpers:
- `R.btn(label, onClick, title?, className?, hotkey?, disabled?)` → EditorButton
- `R.icon(name)` → R.img caches via `_iconsCache`
- `R.multilineText(txt)` → splits, makes .ts/.js/.json paths clickable to editFile
- `R.imageIcon(file)` → sprite sheet frame preview with hover preview
- `R.classIcon(constructor)` → from `__EDITOR_icon` or 'tree/game'
- `R.sceneNode(node)` → icon + name + class + ID + description
- `R.tip(id, header, text)` → Tip component
- `R.input(props)` → warns if onChange (should be onInput)

Image preview system L190-238: `imagePreviewContainer` in body, 100ms hover delay.

`Object.assign(R, BasicR)` L210: merges base HTML element factories.

## basic-preact-fabrics (`engine/basic-preact-fabrics.ts`)

`class R` — basic factory for runtime use (no editor deps):
- All HTML element types: div, form, span, p, img, button, label, b, a, br, hr, svg, td, tr, th, tbody, thead, table, polyline, textarea, iframe, h2-h6, script, meta, space, smallSpace, select, option, strong, small
- `R.fragment(...children)` → Fragment via preact `h`
- Dynamic loop generates factory methods at module load

Split from editor-side to avoid importing editor into engine.
