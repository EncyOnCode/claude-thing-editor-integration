# Writing .c.ts components

## Minimal skeleton

```typescript
import editable from 'thing-editor/src/editor/props-editor/editable';
import Container from 'thing-editor/src/engine/lib/assets/src/basic/container.c';
// or DSprite, Shape, Scene, etc.

export default class MyComponent extends Container {
  @editable()
  myField: number = 0;

  init() {
    super.init();  // MANDATORY - validates via EDITOR_FLAGS._root_initCalled Set
    // ... custom init
  }

  update() {
    super.update();
    // ... per-frame logic
  }

  onRemove() {
    super.onRemove();  // MANDATORY - validates via EDITOR_FLAGS._root_onRemovedCalled Set
    // ... cleanup
  }
}
```

## @editable decorator

`thing-editor/src/editor/props-editor/editable.ts`:

```typescript
function editable<T extends DisplayObject>(desc?: EditablePropertyDescRaw<T>) {
  return function (target: T, propertyName: string) { ... };
}
```

Decorator pushes to `Class.__editablePropsRaw` array (own property assertion at L34).

Auto-source URL via stack trace parsing (L51-63): stores `__src` for "Go to property definition".

For `type: 'btn'`: forces `notSerializable=true`, requires explicit `name`.

`_editableEmbed(targets, name, desc)` L15-29: register on prototype without source access. Used when decorating built-in PIXI types.

## Every @editable type

| Type | Default | Renderer file | Options |
|------|---------|--------------|---------|
| `'number'` | 0 | number-editor.ts | min/max/step/basis |
| `'slider'` | 0 | slider-editor.ts | min/max/step (required) |
| `'string'` | null | string-editor.ts | multiline |
| `'boolean'` | false | boolean-editor.ts | — |
| `'color'` | 0 | color-editor.ts | — |
| `'image'` | null | image-editor.ts | filterAssets |
| `'sound'` | null | sound-editor.ts | filterAssets |
| `'prefab'` | null | prefab-property-editor.ts | filterAssets |
| `'resource'` | null | resource-editor.ts | filterAssets |
| `'l10n'` | null | l10n-editor.ts | — |
| `'btn'` | undef | btn-editor.ts | onClick, title (notSerializable forced) |
| `'splitter'` | undef | (group header) | title (notSerializable forced) |
| `'ref'` | undef | refs-editor.ts | type, read-only (notSerializable forced) |
| `'data-path'` | null | data-path-editor.ts | isValueValid |
| `'callback'` | null | call-back-editor.ts | filters to functions only |
| `'timeline'` | null | timeline/timeline-editor.ts | — |
| `'pow-damp-preset'` | null | pow-damp-preset-selector.ts | — |
| `'rect'` | null | rect-editor.ts | rect_min/max X/Y/W/H, guideColor |
| `'spine-sequence'` | null | spine-sequences/spine-sequences-editor.ts | — |
| `'curve'` | null | curve-property-editor.ts | — |
| `'select'` | varies | select-editor.ts | select (required) |

## All @editable options

```typescript
interface EditablePropertyDescRaw<T> {
  // Numeric constraints
  min?: number;
  max?: number;
  step?: number;
  basis?: number;       // radix for hex/octal in number input

  // Type & naming
  type?: EditablePropertyType;
  name?: string;        // override property name
  title?: string;       // splitter header

  // Values
  default?: any;        // initial value (required if serializable)
  canBeEmpty?: false;   // disable null option

  // Visibility & state
  visible?: (o: T) => boolean;
  disabled?: (o: T) => string | undefined | boolean | null;  // string = reason

  // Editors
  renderer?: any;       // custom Preact component
  select?: SelectEditorItem[] | (() => SelectEditorItem[]);
  animate?: true;       // enable timeline recording
  multiline?: boolean;  // textarea for string

  // Metadata
  helpUrl?: string;
  tip?: string | (() => string | undefined);
  hotkey?: Hotkey;
  important?: boolean;  // highlight in UI

  // Callbacks
  parser?: (val: any) => any;          // transform on save
  beforeEdited?: (val: any) => void;   // pre-edit hook
  afterEdited?: () => void;            // post-edit hook
  onBlur?: () => void;
  onClick?: (ev: any) => void;         // button click handler

  // Serialization
  notSerializable?: true;
  override?: true;                      // override parent class property
  arrayProperty?: true;                  // array field
  defaultArrayItemValue?: any;
  separator?: true;                      // visual separator

  // Validation
  noNullCheck?: true;                   // skip NaN wrap
  isValueValid?: (val: any) => boolean;
  filterAssets?: (file: FileDesc) => boolean;
  filterName?: string;

  // Rect bounds
  guideColor?: number;
  rectScaleIgnore?: true;
  rect_minX/maxX/minY/maxY/minW/maxW/minH/maxH?: number;
}
```

## Type inference

`classes-loader.ts` L94-96: if `type` omitted, inferred from instance value at decoration time.

Auto-detects: `number`, `string`, `boolean`. For other types must specify explicitly.

## Default values

`classes-loader.ts` L113-124:
- `default` from descriptor OR
- value from instance (if assigned in field declaration) OR
- `PropsEditor.getDefaultForType()` fallback
- Asserts present for serializable (L121)
- Merged from parent classes (L204)

## Inheritance merging

`classes-loader.ts` L196-244:
- Walks prototype chain via `__proto__`
- Unshifts parent props to front (L203)
- Merges `__defaultValues` from parents (L204)
- Stops at `__root-splitter` marker (L205-207)
- Dedupes by name; allows override via `override: true` (L215-232)
- Sorts with splitter at top (L150-158)
- Final `Class.__editableProps` is merged + deduplicated + sorted (L235)

## Property naming conventions

- `_name` (single underscore) — backing field for getter/setter, fine to serialize
- `___name` (triple underscore) — auto-marked `notSerializable=true` (classes-loader.ts L99-101)
- `__name` (double underscore) — typically editor-only or special; `__` prefix kept by editor
- Names starting with digit/underscore are invalid for class names (new-component wizard validates)

## Lifecycle hooks (instance)

All optional; engine checks existence before calling.

```typescript
init(): void;                              // MUST call super.init()
update(): void;                            // per-frame; MUST call super.update() if inheriting
onRemove(): void;                          // MUST call super.onRemove()
_onRenderResize(): void;                   // on viewport resize (via processOnResize)
_onDisableByTrigger?(): void;              // when ancestor Trigger hides this

// Serialization (EDITOR-only)
__beforeSerialization?(): void;            // before object serialized to JSON
__afterSerialization?(data: SerializedObject): void;  // after, may modify data
__beforeDeserialization?(): void;          // before properties applied
__afterDeserialization?(): void;           // after init chain

// Selection (EDITOR-only)
__onSelect?(): void;                       // selected in tree
__onUnselect?(): void;                     // deselected
__onChildSelected?(): void;                // a descendant was selected
__isAnyChildSelected?(): boolean;          // custom check

// Preview mode (EDITOR-only)
__goToPreviewMode?(): void;                // entering preview (e.g., show mask outline)
__exitPreviewMode?(): void;                // exiting preview

// Misc (EDITOR-only)
__EDITOR_onCreate?(isForWrapping?: boolean): void;  // when instantiated by editor
__beforeDestroy?(): void;                  // before destruction
__checkWarnings?(): void;                  // custom validation, shows status warn
__shiftObject?(dX: number, dY: number): void;  // override arrow-key shift
__treeInjection?(): ComponentChild;        // custom tree UI
onLanguageChanged?(): void;                // L language switched
__onIsMobileChange?(): void;               // isMobile toggle
```

## Lifecycle hooks (static)

```typescript
static __canAcceptParent?(parent: Container): boolean;
static __canAcceptChild?(Class: Constructor): boolean;
static __isPropertyDisabled?(fieldName: string, o: Container): string | boolean | null;
static __isScene?: boolean;                // auto-set true if extends Scene
static __EDITOR_tip?(): ComponentChild;    // help text
static __EDITOR_icon?: string;             // 'tree/icon-name'
static __requiredComponents?: Constructor[];  // required siblings
static __validateObjectData?(data: SerializedObject): SerializedDataValidationError;
static __beforeChangeToThisType?(oldObj: Container): void;
static __sourceCode?: string;              // raw source text
```

## SelectableProperty markers (on methods/properties for chooser dialogs)

```typescript
methodOrField.___EDITOR_isHiddenForChooser?: true | string;
methodOrField.___EDITOR_isHiddenForCallbackChooser?: true;
methodOrField.___EDITOR_isHiddenForDataChooser?: true;
methodOrField.___EDITOR_isGoodForChooser?: true;        // explicit allow
methodOrField.___EDITOR_isGoodForCallbackChooser?: true;
methodOrField.___EDITOR_ChooserOrder?: true;
methodOrField.___EDITOR_actionIcon?: ComponentChild;    // icon in chooser
methodOrField.___EDITOR_callbackParameterChooserFunction?: (owner) => Promise<any[]>;
```

## Pow-damp presets (for type:'pow-damp-preset')

13 presets (`pow-damp-preset-selector.ts` L53-130):

| Name | p | d | Use case |
|------|---|---|----------|
| None | — | — | empty |
| Alive 1s | 0.02 | 0.85 | linear decay |
| Alive 0.5s | 0.06 | 0.7 | |
| Alive 0.25s | 0.16 | 0.55 | |
| Smooth 1s | 0.012 | 0.8 | smooth curve |
| Smooth 0.5s | 0.032 | 0.7 | |
| Smooth 0.25s | 0.1 | 0.52 | |
| Bouncy 3s | 0.03 | 0.95 | elastic |
| Bouncy 1s | 0.05 | 0.85 | |
| Bouncy 0.5s | 0.3 | 0.73 | |
| Balloon | 0.001 | 0.9 | very elastic |
| Inert | 0.002 | 0.98 | almost no motion |
| Discrete | 1 | 0 | instant |

Used by Trigger.pow/damp and timeline keyframes. Equation:
```
speed += (target - val) * pow;
val += speed;
speed *= damp;
```

## Validation (number/color fields)

`classes-loader.ts` L103-106: wraps setters with NaN guard. `noNullCheck: true` disables.

Min/max enforced in props-field-wrapper.ts onChange (L292-305). Step rounding via Math.round.

## Common real-world example

```typescript
import editable from 'thing-editor/src/editor/props-editor/editable';
import getValueByPath from 'thing-editor/src/engine/utils/get-value-by-path';
import callByPath from 'thing-editor/src/engine/utils/call-by-path';
import DSprite from 'thing-editor/src/engine/lib/assets/src/basic/d-sprite.c';
import { container } from 'tsyringe';
import { EventBusToken } from '../types/diTokens';

export default class CardItem extends DSprite {
  @editable({ type: 'data-path', isValueValid: (o: any) => o instanceof MovieClip })
  cardSpritePath: string | null = null;

  @editable({ type: 'callback' })
  onSelected: string | null = null;

  @editable({ min: 0, max: 1, step: 0.01 })
  glowAlpha = 0.5;

  private cardSprite?: MovieClip;
  private eventBus?: EventBus;

  init(): void {
    super.init();
    if (this.cardSpritePath) {
      this.cardSprite = getValueByPath(this.cardSpritePath, this);
    }
    this.eventBus = container.resolve<EventBus>(EventBusToken);
    this.eventBus.on('card-selected', this.handleSelect, this);
  }

  handleSelect = (data: any) => {
    if (this.onSelected) callByPath(this.onSelected, this);
  };

  onRemove(): void {
    super.onRemove();
    this.eventBus?.off('card-selected', this.handleSelect, this);
    this.cardSprite = undefined;
  }
}
```

## Templates

`thing-editor/src/editor/templates/`:
- `basic-scene.tst` (46 lines) — minimal Scene
- `full-scene.tst` (110 lines) — Scene with all hooks
- `basic-game-object.tst` (34 lines) — minimal Container
- `full-game-object.tst` (112 lines) — Container with all hooks + validation

Substitutions:
- `NEW_CLASS_NAME` → entered class name
- `BASE_CLASS_NAME` → selected parent
- `BASE_CLASS_PATH` → parent source path (without .ts)
- `CURRENT_PROJECT_DIR` → `/games/{projectDir}`

After 3+ components, wizard strips comments via regex.

## Old reference detection

`old-references-detect.ts`:
- `markOldReferences(o)` wraps Container-typed fields with proxy at destroy
- On next destroy, compares ref to stored proxy
- If unchanged → error code 10048 + suggestion: use `@editable({type:'ref'})` or clear in onRemove

To avoid: clear Container refs in onRemove OR mark with `@editable({type:'ref'})`.

## Target helper pattern (recommended)

From wiki/base-wiki.md:
```typescript
// OLD (manual cleanup):
@editable({ type: 'data-path' }) targetPath = '';
target?: Container;
init() { super.init(); this.target = getValueByPath(this.targetPath, this); }
onRemove() { super.onRemove(); this.target = undefined; }

// NEW (auto-cleanup):
@editable({ type: 'data-path' }) targetPath = '';
get target() { return targetHelper<Container>(this, 'targetPath'); }
```

`target-helper.ts` patches `onRemove` to auto-clear cached refs (target-helper.ts L41-54).
