---
name: thing-editor
description: Use this skill ANY time the user is working with Thing-Editor projects (PixiJS v7-based game engine with JSON-serialized scenes and `.c.ts` components). Trigger when the user mentions Thing-Editor, edits files matching `*.c.ts`, `*.s.json`, `*.p.json`, `thing-project.json`, opens `assets/main.s.json`, references the `@editable` decorator, `MovieClip`, `TickerTween`, `ShapeButton`, `DSprite`, scene faders, prefab references (`"r":` keys), the `game` singleton (`game.showScene`, `game.all`, `game.showModal`), data-paths like `"all.cardFactory"`, or asks how to position/anchor objects, write a custom component, animate properties, manage scenes/modals, load prefabs, or use any built-in component (Button, Shape, Toggle, ProgressBar, Spine, ParticleContainer, etc.). Also trigger when working in `thing-editor/` repo, `skill-games-*` projects, or any directory containing a `thing-project.json`. This engine has many non-obvious conventions (DSprite anchor 0.5, JSON `"c"`/`"p"`/`":"`/`"r"` keys, `super.init()` requirement, `_onRenderResize`, scene-linked Delay/Promise, RemoveHolder destruction) — consult the reference rather than guessing.
---

# Thing-Editor

PixiJS v7.2.4 game engine. Scenes/prefabs serialized to JSON, behavior in TypeScript `.c.ts` components. Editor runs in Electron; runtime is browser/Cordova.

## When to load the reference

`references/engine-reference.md` is the full API (~900 lines). Load the relevant section using Read with `offset`/`limit` based on the user's task. Don't dump the whole file — the table of contents below maps tasks to sections.

## Reference table of contents

| Task | Section in `references/engine-reference.md` |
|---|---|
| Class hierarchy (Container/Sprite/DSprite/MovieClip/Shape) | "Class Hierarchy" |
| Writing a new `.c.ts` component | "Component (`.c.ts`) Skeleton" |
| Reading/writing scene JSON, prefab JSON | "Scene JSON Format" |
| Position, scale, rotation, anchor, pivot | "Transforms & Positioning" |
| `game.showScene` / `showModal` / scene stack | "Scene Management" |
| Data path strings (`"all.x"`, `"this.y"`, `"data.z"`) | "Data Path System" |
| `@editable()` decorator options | "`@editable()` Decorator" |
| MovieClip timeline, labels, keyframes | "MovieClip Timeline Animation" |
| Code-driven animation | "TickerTween" |
| Vector shapes / interactive buttons | "Shape Component", "ShapeButton" |
| Sprites, tint, blend modes | "Sprite / Image" |
| Loading prefabs at runtime | "Prefabs", "Asset Access" |
| Sound playback | "Sound" |
| DI tokens (skill-games projects) | "DI (tsyringe)" |
| Scene lifecycle order | "Scene Lifecycle" |
| Frame update timing | "Update Loop" |
| Localization (`l('key')`) | "Localization" |
| `#if EDITOR/DEBUG/NOT-EDITOR` directives | "Preprocessor Guards" |
| `game.data` for shared state | "`game.data`" |
| Find object, remove self, add filter | "Common Patterns" |
| Built-in classes (Text, Toggle, ProgressBar, Spine, etc.) | "Built-in Component Catalog" |
| Frame-counted timer | "Delay" |
| Scene-linked promises | "SceneLinkedPromise" |
| Object pooling | "Pool" |
| Function-by-path invocation | "callByPath" |
| Keyboard input | "Keys" |
| Persistent storage | "Settings" |
| Scenes that survive pop | "Static Scenes" |
| Scene click/move handlers | "Scene Mouse Handlers" |
| Class-level editor metadata | "Editor Metadata" |
| `.tmp/classes.js`, `assets-preloader/main/delayed.json` | "Build Artifacts" |
| Custom transition prefabs | "Fader System" |
| Spine skeletons | "Spine Support" |
| Particle effects | "Particles" |
| Window resize / orientation | "Resize Handling" |
| `thing-project.json` schema | "ProjectDesc" |
| Editor UI shortcuts | "Editor Tips" |
| Pitfalls (DSprite anchor, init order, listener leaks) | "Common Gotchas" |

## Non-negotiable rules

When writing or modifying Thing-Editor code:

1. **Always `super.init()`** at top of any component's `init()` — engine schedules `_onRenderResize()` from there.
2. **Always `super.onRemove()`** + remove every listener registered in `init()`. Otherwise: ghost callbacks, memory leaks.
3. **Never hand-edit `.s.json` / `.p.json`** unless changing one specific value the user asked for. The editor sorts keys differently and produces large diffs.
4. **`@editable` props are auto-serialized.** Default values must be set as field initializers (`myProp = 0`) — those become defaults in scene JSON.
5. **Code in `/// #if EDITOR ... /// #endif` is stripped at build.** Don't put runtime logic there. Conversely, editor-only metadata (`__EDITOR_icon`) belongs inside.
6. **`DSprite` anchor defaults to 0.5** (center). Plain `Sprite` defaults to 0,0 (top-left). Position math depends on this.
7. **Always `.destroy()` `TickerTween`** in `onRemove()` — each holds its own `PIXI.Ticker`.
8. **`Delay.delay(cb, frames)` over `setTimeout`** — auto-cancelled on scene exit.
9. **Object names with `.`, `#`, `\``, `,` get auto-replaced** with `_` (those chars used in data-paths).
10. **`super.update()` propagates update to children** — omit only when manually updating children.

## Scene JSON quick read

```json
{
  "c": "ClassName",          // class name
  "p": { "x": 0, "name": "foo", "scale.x": 1.5 },  // props (dot notation)
  ":": [ { "c": "Child", "p": {} } ],              // children
}
// Prefab reference:
{ "r": "prefabName", "p": { /* overrides */ } }
```

## Component skeleton

```typescript
import editable from 'thing-editor/src/editor/props-editor/editable';
import game from 'thing-editor/src/engine/game';
import { Container } from 'pixi.js';
import getValueByPath from 'thing-editor/src/engine/utils/get-value-by-path';

export default class MyComp extends Container {
  @editable() myNum = 0;
  @editable({ type: 'data-path' }) targetPath = '';

  private target: Container | null = null;

  init() {
    super.init();
    if (this.targetPath) this.target = getValueByPath(this.targetPath, this);
    this.on('pointerdown', this.onDown);
  }

  onRemove() {
    super.onRemove();
    this.removeListener('pointerdown', this.onDown);
  }

  private onDown = () => { /* ... */ };
}

/// #if EDITOR
MyComp.__EDITOR_icon = 'tree/container';
/// #endif
```

## Working with the user

- For "how do I…" questions, find the relevant section in the reference, read it, then answer concisely with code.
- When asked to write a new component, follow the skeleton above and load the "Component (`.c.ts`) Skeleton" + "`@editable()` Decorator" sections first.
- When asked to position objects, load "Transforms & Positioning" — note no built-in layout system, layout goes in `_onRenderResize()` or services.
- When debugging a runtime error, check "Common Gotchas" first.
- For multiplayer skill-games projects (`skill-games-durak`, etc.): DI tokens go through tsyringe (`EventBusToken`, `ClientProviderToken`, `ConnectionServiceToken`).
- The user's project tree usually has `assets/main.s.json` (main scene), `assets/src/custom/*.c.ts` (components), `assets/*.p.json` (prefabs). Custom components live in `assets/src/custom/`.
