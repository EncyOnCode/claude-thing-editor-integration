# Non-obvious gotchas + sharp edges

Catalog of everything that surprised during the deep dive.

## Lifecycle

1. **`super.init()` enforcement** — EDITOR_FLAGS._root_initCalled Set validates. Missing super.init() → error code 10047 (or similar). Same for super.onRemove() via _root_onRemovedCalled.

2. **DSprite default anchor 0.5/0.5** — constructor hard-sets it. Inherit DSprite if you want center-anchored sprite; use Sprite for top-left anchor.

3. **Scene cannot be removed** — `Scene.prototype.remove()` throws (scene.c.ts L76-78). Use `game.closeCurrentScene()`.

4. **Scene `__canAcceptParent = false`** — can't be added as child of anything.

5. **Scene.all is a proxy in EDITOR** — `ACCESS__ALL_ASSERTING_PROXY` throws if accessed before scene init.

6. **RemoveHolder defers destroy 1 frame** — never sync-read refs from destroyed subtree. `Lib.removeHoldersToCleanup` drained next `_cleanupRemoveHolders()` call.

7. **Pool reuse keeps state** — `init()` MUST reset all instance state. Editor pool validation strict: no orphan event listeners, no children when disposed (Pool L25, L68).

8. **EDITOR pool randomized** — `pools.get(constructor).pop()` is randomized in editor (Pool L65) to catch use-after-dispose. Runtime LIFO.

9. **`__nodeExtendData` NOT serialized** — all editor metadata (selection, prefab refs, isolation, breakpoints) lives there. Cleared to `EMPTY_NODE_EXTEND_DATA` post-destroy.

10. **`game.editor` undefined in runtime** — anything touching `editor.*` must be in `/// #if EDITOR ... /// #endif`.

## Sound

11. **Volume is quadratic** — values stored as sqrt, applied as val². So `0.1` is essentially off (1% effective), `0.5` ≈ 25% perceived, `1.0` max.

12. **`MIN_VOL_ENABLE = 0.10000001`** — anything ≤ 0.10000001 counts as "muted".

13. **`Sound.playPitched()` increments pitch per replay** — guards against rapid spam. Resets after `resetTimeout` (200ms default).

14. **iOS audio lock** — `Sound.checkSoundLockByBrowser()` detects via test sound + timeout. `soundLockHandler(true|false)` called on detection/unlock.

15. **`Sound.play()` returns early if `!game.isVisible`** (except editor) — tab-switched audio doesn't play.

16. **`__sounds-panel-is-left` etc keys** — sound debug panel settings (F3 toggle). Persisted to editor.settings.

## Keys

17. **`keyup` deferred** — buffered in `keyUpsToApply[]`, applied on next `Keys.update()`. Frame-perfect game input pattern. Editor bypasses (keyup updates immediately).

18. **Arrow keys AND WASD both checked** — `Keys.up` true for keycode 38 OR 87, etc.

19. **Cross-frame key listeners** — `keys.ts` attaches to all parent frames; silently catches cross-origin errors.

## Loading + transitions

20. **Loading gate balance required** — `game.loadingAdd(owner)` and `game.loadingRemove(owner)` must balance. Imbalance blocks fader hide forever.

21. **DEBUG asserts owner uniqueness** — `loadingsInProgressOwners` Set checked in loadingAdd. Same owner added twice = assertion failure.

22. **`_isWaitingToHideFader` gates scene transitions** — scene changes accumulate in scenesStack but don't apply until fader covers and waits for loading=0.

23. **`final-fader.p.json` shown on `_reloadGame()`** if prefab exists (game.ts L951).

24. **Modal must NOT be a Scene** (game.ts L1090 assert).

25. **`modal-promise-awaiter` child name required** — `showModal(c, callback)` creates SceneLinkedPromise child with this exact name (L1093-1096).

## Resize

26. **`onResize()` called with delays [1, 20, 40, 80, 200, 500, 1000, 1500, 2000, 3000]ms** — cascading layout settles after orientation change.

27. **`Texture.WHITE` workaround** — `_startGame` fills WHITE texture context (pixijs#8315 / BGG-6807).

28. **WebGL context loss reload** — 60-frame delay before reload, only if WebGL + visible (game.ts L802-813).

29. **`processOnResize` only calls `_onRenderResize` if defined** — not on every Container. Implement explicitly when needed.

30. **`forAllChildrenEverywhere(callback)`** walks scene stack + static scenes (game.ts L668).

## Assets / Lib

31. **Spritesheet+BMF loader hijack runtime-only** (`Lib._initParsers` L82-84). Editor uses different path. Production must populate `unHashedFileToHashed`.

32. **`unHashedFileToHashed.get(url)` throws if missing** — runtime spritesheet loader (L56).

33. **`Lib.REMOVED_TEXTURE`** — fallback placeholder for missing/deleted textures. Editor replaces deleted with REMOVED_TEXTURE preserving updateID.

34. **Textures retried up to 3× with exponential backoff** on load fail (L310-327).

35. **`Lib.addTexture` updates baseTexture in-place in editor** (L344-345) but reassigns in runtime (L351).

36. **Atlas texture loading: 'spritesheetLoader' parser intercepted** — `asset.meta.image` rewritten BEFORE original parser sees it.

37. **`Lib.ASSETS_ROOT = './assets/'`** — relative to build output dir. Don't hardcode different paths.

38. **`__prefabsDefaults` cache** in get-prefab-defaults.ts — `invalidatePrefabDefaults()` clears.

## LOD

39. **LOD upgrade swaps baseTexture on derived textures** sharing it (lib.ts L575-584). Direct Texture.from(canvas) won't share base, so LOD won't reach those.

40. **`game.projectDesc.lowQualityVariants[fileName]` exists** = file is LOD; the variant maps original → low-res filename.

41. **`_lodUpgradeInProgress` flag** prevents concurrent upgrades.

42. **LOD scale affects quality, not dimensions** (spritesheet-builder L415-428) — JSON coordinates must remain compatible.

## On-demand loading

43. **`__loadOnDemandTexturesFolders: { "ondemand": 2 }`** in thing-project.json — bit 2 = early pre-cache.

44. **Bit flags for loadOnDemandTextures values**: 1=demand, 2=pre-cache, 4=mipmap, 8=REPEAT, 16=MIRRORED_REPEAT.

## Serialization

45. **`___`-prefixed fields stripped via `fs.fieldsFilter`** in JSON.stringify replacer (fs.ts L616-620). Never appears in saved JSON.

46. **Editor-mode editor-prefab-references hide children** (lib.ts L1703-1704) — see hidden children via Alt+click on tree.

47. **`__nodeExtendData.serializationCache`** — invalidated by `Lib.__invalidateSerializationCache(o)` which bubbles to game.stage.

48. **`processAfterDeserialization` hooks at depth=0** (lib.ts L959).

49. **`Object.assign(ret, src.p)` order matters** — defaults first, then prefab chain, then override props.

## ifdef preprocessor

50. **No `/// #else` directive** — only #if and #endif. Nest if needed.

51. **Editor file imports in prod throws build error** — `vite-plugin-ifdef` L25-31 enforces.

52. **`@editable(...)` stripped in prod** via multiline paren-balanced parse. Side effect: line numbers shift in source maps.

53. **`assert(...)` stripped in non-DEBUG** — don't put side effects inside assert!

54. **`import type` survives** — only value imports trigger the editor-import filter.

## Build

55. **Prod build CDN URLs** — pixi (jsdelivr@7.2.4), howler (jsdelivr@2.2.3), pixi-spine (jsdelivr@4.0.4). **Offline builds break.**

56. **Dev SPINE_SRC_PATH** = local node_modules path. Pixi alias to local `.mjs` for dev. **Prod swaps to CDN URLs in `define`.**

57. **`preserveSymlinks: true`** — critical for monorepo libs. Without it, symlinked libs resolve through real paths and dedupe breaks.

58. **`build.js` outDir cleanup unlinks files but doesn't remove dirs** — empty dirs accumulate.

59. **JSON minified only in release** (`!debug && asset.endsWith('.json')`).

60. **Spritesheet packing fails silently if >2048×2048** — returns null.

61. **`projectDesc.scenes[0]` is preloader, `scenes[1]` is main** (legacy; mainScene/preloadScene deprecated).

62. **`__buildConfigDebug/__buildConfigRelease` allow custom Vite config per project**.

## Electron

63. **Single-instance lock** — second `npx electron` invocation focuses existing window (index.js L14-23).

64. **Debug mode loads debugger-awaiter.html first** — 600ms hold via setInterval for VSCode debugger attach.

65. **F5 reload only when window focused** — `globalShortcut` unregistered on blur.

66. **`webSecurity: false`** in BrowserWindow — needed for local file access (preload scripts).

67. **`additionalArguments: ['--user-data-dir=' + path.join(os.tmpdir(), 'chrome-user-tmp-data')]`** — isolated browser profile.

68. **`appConfig.set(stateId, ...)`** in electron-settings — windowPosition-{id} keys persist across restarts.

69. **IS_CI_RUN env**: minimizes window, throttles requests 50ms, ignores file watching.

70. **`window.electron_ThingEditorServer.fs()` is SYNC** (ipcRenderer.sendSync) — blocks renderer thread. Use fsAsync for slow ops.

## Editor

71. **History per-scene/prefab stacks** keyed `s/{name}` or `p/{name}`. Editing different scene doesn't pollute another's undo.

72. **History stores FULL serialization** per entry, not diff. HISTORY_LEN=100 with STRICT_HISTORY_LEN=20 (alternate after strict).

73. **History save debounced 1ms after mouseup/keyup/drop**.

74. **Selection save debounced 50ms** (suppressed during STATE_APPLY_TIME).

75. **`IS_SELECTION_LOADING_TIME` flag** suppresses selection auto-save during loadSelection.

76. **Selection sorted by tree depth** — shallowest first for proper undo/delete order.

77. **Hidden child selection redirected** — `getParentWhichHideChildren(o, true)` triggers modal prompting to edit prefab.

78. **Prefab ref click → prompt to edit prefab** — selection.ts L79-91.

79. **`__shiftObject` override exists** (MovieClip shifts timeline) — arrow-key movement consults this.

80. **`__canAcceptParent` / `__canAcceptChild`** static methods checked before drag-drop.

81. **`__hideChildren = true`** — children not selectable in tree (Checkbox does this).

82. **OldReferencesDetect proxy** — Container-typed fields wrapped at destroy; checked on next destroy. Error code 10048 with hint.

83. **`target-helper` patches `onRemove`** to auto-clear cached refs — preferred pattern.

84. **Pool dispose validates** no event listeners, no children. Editor strict.

## Props editor

85. **Multi-select intersection** — only props visible on ALL selected shown. Disabled with reason if not all have it.

86. **`field.parser` applied BEFORE `field.renderer.parser`** in PropsFieldWrapper.onChange.

87. **NumberEditor expression eval** via `eval()` (props-editors/number-editor.ts L146) — security-sensitive but editor-only.

88. **NumberEditor Ctrl+drag/Ctrl+arrows = 10×** step.

89. **SliderEditor requires min/max** — propertyAssert fails without.

90. **SelectEditor max 20 items** in list (line 169).

91. **CurvePropertyEditor first+last keyframes fixed time** — can't drag t=0 or t=1.

92. **`select-lists-root` portal div** in body — dropdown renders here, not in editor window.

93. **Class change with `onChangeClassClick`** deserializes with new class — properties not in target class are lost.

94. **`__editableProps` merged across __proto__ chain** with override support (classes-loader L196-244).

## Class-loader

95. **Classes dynamically imported with `?v=componentsVersion` query** for cache-bust (L164-166).

96. **Engine lib classes NOT versioned** (L164-166 exception) — performance.

97. **`__editablePropsRaw` must be OWN property** (L34 assert) — inherited array would mutate parent class.

98. **Type auto-detected from instance value at decoration time** if `type` omitted.

99. **`___`-prefix props auto-marked notSerializable** (L99-101).

100. **`__className` may differ from filename** — class-loader L64-74 fixes by stripping leading underscores if mismatched.

## Animation

101. **MovieClip `_disposePlayers()` returns FieldPlayers to pool** on timeline change.

102. **Timeline `j` (jump time) defaults to `t`** if omitted — keyframe doesn't loop. Set `j < t` for backward loop or `j > t` for forward repeat.

103. **`r` (random delay) applied at keyframe boundary** — `time += Math.round(Math.random() * r)`.

104. **`m` (mode) defaults to SMOOTH (0)** if omitted in serialization.

105. **LINEAR keyframe `speed` precomputed on entry** — can be overridden via `s` field. SMOOTH preserves current speed.

106. **Non-numeric properties → DISCRETE only** in timeline editor.

107. **MovieClip in prefab reference disables timeline editing** (movie-clip.c.ts L39 visible filter).

108. **Pow-damp Discrete preset = `p:1, d:0`** — instant snap.

109. **Curve time clamped 0-1**, values outside return boundary value.

110. **curveHelper cache NOT invalidated on field change** — manually `delete this._curveInstance_fieldName` if curve data mutated.

## SceneLinkedPromise

111. **NOT a native Promise** — `.then().then()` returns SAME instance.

112. **Auto-rejects on owner destroy** — onRemove if still waiting → calls `_handleFinally()`.

113. **promiseId increments per pool reuse** — prevents stale callbacks on reused instances.

114. **Editor random throttle 0-15 frames** simulates async behavior.

115. **Handler error wrapped in 1ms timeout DEBUG-only** — catches "stop on caught exception" debugger setting.

## Delay

116. **`delayFrames <= 0` executes synchronously in factory** (delay.c.ts L42-45) — not next frame.

117. **`delay.skip()` forces immediate execution** + removes self.

118. **Constructor asserts no args** — must use `Delay.delay(callback, frames, container)` factory.

## Spine

119. **pixi-spine loaded via script tag (NOT ES module)** — `static _loadSpineRuntime()` runs at module load.

120. **Spine pool isolated by name** — `_poolName` field tracks identity. `Spine.allocatePool(name, count)` pre-allocates.

121. **Custom atlas parser hijack** for hashed/LOD/cloud textures — bypasses standard atlas loading.

122. **`settings.REPORT_TEXTURE_LOADER_ERROR`** gates error logging — toggle if Spine spams errors.

123. **`spinesPooling: boolean` @editable** — disable per instance if pool causes issues.

124. **`replaceAtlasPageTexture` walks all skins** — slow for complex skeletons; cache base names.

125. **Sequences use linked-list pointers** — `___next` on items and actions for fast iteration.

## ScrollLayer / ScrollBar

126. **Only ONE ScrollLayer can drag at a time** — `static draggingLayer: ScrollLayer | null`. Cross-layer drag = bug.

127. **x/y must be 0 for ScrollLayer** — disabled in editor with DISABLE_XY_TIP. Wrap in container if you need positioning.

128. **ScrollBar drag bypasses applyLimit** — directly sets `ScrollLayer._virtualScrollY` (scroll-bar.c.ts L577-581).

129. **ScrollBar autoHideTimer persists** — must clear in onRemove.

130. **ScrollLayer bouncingBounds = true** uses stepTo with 1/4 limit shift.

131. **WHEEL_EVENT_OPTIONS** differs EDITOR (true) vs runtime (`{passive: false, capture: true}`).

## Trigger / OrientationTrigger

132. **Trigger stops updating children when invisible** (alpha ≤ 0.015 OR scale ≤ 0.0015) — entire subtree update halted.

133. **Trigger `applyInstantly()` runtime-only** (L126 assert).

134. **OrientationTrigger IGNORE_DIRECT_PROPS flag** prevents recursion during serialization.

135. **Setting x/y/rotation/scale on OrientationTrigger updates BOTH portrait + landscape variants** (unless IGNORE_DIRECT_PROPS set).

136. **OrientationTrigger callbacks delayed 600ms in EDITOR** — debounce.

137. **Trigger pow=1 means instant switching** (L168).

## Particle / Mesh

138. **ParticleSystem curve sampling fixed at 20 points** (`curveToList` L137-145).

139. **ParticleContainer `forAllChildren` runtime-bypassed** — skips children at runtime to avoid iteration.

140. **Fill requires power-of-two textures** for TEXTURE_WRAP_MODE.

141. **NineSlicePlane `useOldBehaviour: false` requires pixelPerUnit scaling**.

## HTMLOverlay

142. **Position absolute in EDITOR, fixed in runtime** — different coordinate systems.

143. **bouncingBounds forced false** (init L67) — overrides Resizer setting.

144. **`_overlayInterval` runs every ~16ms** independent of game updates.

145. **className gets repeating suffixes**: `portrait- landscape- mobile- desktop-` → e.g., `portrait-myclass mobile-myclass`.

## ProgressBar

146. **`bar`/`cap` re-searched every applyQ in EDITOR** but then nulled — weird editor behavior.

147. **`itemsCount` animations called cumulatively** (while loop L244) — calledItem increments.

148. **`onChanged` fires on value change, not UI interaction end** — bind to `afterSlide` instead for end-of-drag.

## L10n

149. **`{#globalKey}` regex `/\{#([a-zA-Z0-9_.-]+)\}/g`** — only alphanumeric, underscore, dot, hyphen.

150. **Missing global key returns original pattern** `{#key}` — not empty string.

151. **Setting `globalConfig` directly won't update Text** — must use `L.setGlobalValue(key, value)`.

152. **Deserialization flattens nested keys** — `{a: {b: {c: "v"}}}` → `"a.b.c": "v"`.

153. **L10n key naming**: `/^[a-zA-Z0-9_./]+$/`, no leading/trailing dot.

154. **Auto-creates `.l.json` files for new languages** unless `__doNotAutoCreateLocalizationFiles`.

155. **L() global processing order**: globals first, then localization keys, then values params.

## Data paths

156. **`#name` = `getChildByName('name')`** — not a literal property access.

157. **`'this'` and `'all'` are special roots** — handled before property lookup.

158. **Method invocation applies result to OWNER** (fOwner) — dangerous if path ends on property named same as method.

159. **Path parsing cached in `_callsCache` Map** by full string — no invalidation on code changes (but EDITOR hot-reloads).

160. **Number parsing**: `0x`/`#` prefix = hex, contains `.` = float, true/false = boolean, else string.

161. **`setValueByPath` asserts target NOT a function** — can't overwrite methods.

162. **`callByPath` throws if any step missing** — unlike `getValueByPath` which returns undefined.

163. **Editor path resolution debugger** — `__nodeExtendData.__pathBreakpoint === path` triggers debugger statement.

## Selection / History

164. **Selection clears on `select()` unless `add=true`** — Shift/Ctrl+click in tree-node sets add=true.

165. **Selection path `i` = index among siblings with SAME name** — duplicates handled.

166. **History stage pan/zoom in selectionData** — undo restores camera position.

167. **History prune logic**: keeps [0..STRICT_HISTORY_LEN], then every-other entry from STRICT to HISTORY_LEN.

168. **Selection sorted by depth** before delete — proper hierarchical removal.

## Build dialog / version

169. **Version validates `/^\d+\.\d+\.\d+/`** — minor version digit required.

170. **`generateBuildNumber() = Math.floor(Date.now() / 1000)`** — Unix timestamp.

171. **`generateDateString() = YYYYMMDD`** — no separators.

172. **No automatic migrations on version bump** — version is metadata only.

## Modal / UI

173. **Modal stack supports `toBottom: true`** — unshifts for stack-level priority.

174. **Notification auto-hides 1200ms** — dedup via hideId.

175. **Error modal pauses game if running** (modal.ts L255) via `game.editor.pauseGame()`.

176. **Spinner blocks UI** — `Modal.isUIBlockedByModal()` checks.

177. **`#root`, `#select-lists-root`, `#context-menu-root` are separate divs** in index.html.

## Build sounds

178. **WAV → multi-format transcoding cached in `~snd-convert-cache.json`** — hash + mTime + bitrate.

179. **5× retry on EACCES** (file locked) with 1s interval.

180. **WebM uses `-dash 1` flag**.

181. **ffmpeg located via `.bin/ffmpeg/` or PATH** — user installs separately.

## Resolver

182. **Query string `?` appended to imports from games/libs** — cache-bust on edits.

183. **CI throttle 50ms per request** prevents Chrome crash on rapid rebuilds.

184. **`prefabs-typing` import stubbed** to empty class export.

## TickerTween

185. **`ticker.speed` affects pixi-managed animations** — DEBUG accounts for it (game.ts L746).

186. **`isUpdateBeforeRender`** true only on LAST iteration of update batch (when frame will render).

## Theme

187. **Theme CSS files dynamically `<link>` injected** — `data-theme` attribute used for cleanup.

188. **Theme list discovered from `thing-editor/src/editor/themes/` dir scan** — falls back to hardcoded light/dark on error.

189. **Per-project theme persisted** — saved with project ID.

## Misc

190. **`game.mouse` is CLAMPED to viewport** — unclamped at `game.__mouse_uncropped` (EDITOR only).

191. **`getDomBoundsFromPixi`** pivot subtraction L14-15 — assumes pivot defines offset from global position.

192. **Resolution multiplier** matters for retina displays — `renderResolution` in projectDesc.

193. **Cordova-only `game.exitApp()`** — Back button triggers `Button._tryToClickByKeycode(27)`.

194. **`addOnClickOnce` defers callbacks to next user gesture** — for fullscreen, audio unlock, etc.

195. **`auto-fullscreenDesktop` and `autoFullscreenMobile`** trigger on first click (unless EDITOR).

196. **`fontHolderText`** invisible span keeps fonts loaded — typically `'ЯSфz'` (Cyrillic + Latin chars).

197. **`deepFreeze()` DEBUG-only** — throws if used in production (engine/utils/deep-freeze.ts L5).

198. **`assert(cond, msg, errorCode=99999)`** — always throws, no recovery. Fatal.

199. **F1 default URL** — 'editor.Overview' wiki page if no context.

200. **Error codes <90000 get help URL**, ≥90000 use default — `Help.getUrlForError()`.
