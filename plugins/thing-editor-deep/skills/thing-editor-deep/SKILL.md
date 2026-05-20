---
name: thing-editor-deep
description: Deep architectural reference for Thing-Editor (PixiJS v7 game engine, Electron-based editor with Preact UI). Use when modifying engine internals, debugging non-obvious behavior, writing complex .c.ts components, understanding build pipeline, editor internals (history, selection, props-editor, timeline), DI/EventBus/StateMachine patterns in real games, or any task needing precise file/line citations across runtime + editor + electron-main + build. Complements the simpler `thing-editor` skill — this one is for architecture and gotchas, that one for surface API.
---

# Thing-Editor Deep Reference

PixiJS v7.2.4 + TypeScript + Vite + Electron. Built from exhaustive 14-agent deep dive of `/Users/blackmacmini/repo/thing-editor`. ~99% engine coverage with line citations.

## When to load which reference

Load only relevant section(s) with Read+offset+limit. Do not dump everything.

| Task | Reference file |
|------|---------------|
| Runtime lifecycle, ticker, scene/modal/fader stacks, resize, fonts loading | `references/01-runtime.md` |
| Lib class, serialization, prefab/scene loading, texture/sound/atlas, LOD, cloud assets | `references/02-assets-lib.md` |
| Built-in component catalog (every basic/extended/common/custom/mobile class with @editable fields) | `references/03-components.md` |
| Writing .c.ts components, @editable types/options, class hooks (instance + static), lifecycle invariants | `references/04-authoring.md` |
| MovieClip timeline JSON, FieldPlayer easing equations, labels, Curve, Spine animation | `references/05-animation.md` |
| Editor architecture: editor.ts, selection, history, prefab-editor, fs.ts, classes-loader, props-editor renderers | `references/06-editor.md` |
| Build pipeline: ifdef preprocessor, vite plugins, electron main, spritesheet/LQ builders, generated typings | `references/07-build.md` |
| Types: NodeExtendData, ProjectDesc, EditablePropertyDesc, SerializedObject, AssetType, all generated d.ts | `references/08-types.md` |
| Real game patterns: DI tsyringe, EventBus mitt, StateMachine, screen registry, network SDKs, slot/crash engines | `references/09-patterns.md` |
| Non-obvious gotchas, quadratic sound volume, keyup-deferred Keys, Pool validation, RemoveHolder timing, etc. | `references/10-gotchas.md` |

## Quick orientation

**Runtime trees:**
- `thing-editor/src/engine/` — game.ts singleton, Lib, components, utils
- `thing-editor/src/editor/` — Preact UI (stripped from prod via ifdef)
- `thing-editor/electron-main/` — main process, IPC, build pipeline

**Project trees:**
- `games/<name>/thing-project.json` + `assets/` + `assets/src/` (.c.ts custom classes)
- `libs/<name>/thing-lib.json` + `assets/` (shared)

**JSON format:**
- `.s.json` scene, `.p.json` prefab, `.c.ts` class
- Keys: `c` class | `r` prefab ref (mutually exclusive), `p` props (non-default only), `:` children, `__prefabPivot`, `__description`
- Dot-notation props: `"pivot.x"`, `"scale.y"`, `"style.fontSize"`
- Callbacks as arrays: `"onClick": ["this.method", "this.other,arg1,arg2"]`
- Data-paths: `"this.#child"` (# = getChildByName), `"all.named"`, `"path.func,arg1,0xFF,true"`

**Critical invariants (NEVER forget):**
1. `super.init()` and `super.onRemove()` enforced via `EDITOR_FLAGS._root_initCalled` / `_root_onRemovedCalled` Sets
2. DSprite anchor defaults 0.5/0.5
3. Scene `__canAcceptParent = false`, `remove()` forbidden → use `game.closeCurrentScene()`
4. RemoveHolder defers destroy 1 frame; never sync-read refs from destroyed subtree
5. Pool reuse → `init()` must reset state; validation strict in editor
6. Sound volume **quadratic** (val²): 0.1 ≈ off, 0.5 ≈ 25%, 1.0 max
7. Keys `keyup` deferred to next `Keys.update()` frame
8. Loading gate: `game.loadingAdd(owner)` / `loadingRemove(owner)` must balance
9. Prod build pulls pixi+howler from jsDelivr CDN (offline broken)
10. ifdef preprocessor has **no `/// #else`**; nested via stack only

## Existing simpler skill

A `thing-editor` skill already exists (from plugin) with API-level reference. This deep skill ADDS:
- Editor internals (history/selection/props-editor implementations)
- Build pipeline details
- Real game architecture patterns (DI/EventBus/StateMachine)
- Slot/crash engine specifics
- Generated typings flow
- Exhaustive gotcha catalog
- Per-file line citations

When user asks "how to" → existing skill. When user asks "why does X behave Y" / "where is X" / debugging / extending engine → this skill.
