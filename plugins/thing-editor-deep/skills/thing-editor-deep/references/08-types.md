# Type system

## SerializedObject (engine-level)

```typescript
type SerializedObject = {
  c?: string;                            // constructor class name
  r?: string;                            // prefab reference name (mutually exclusive)
  p: SerializedObjectProps;              // properties (non-default only)
  ':'?: SerializedObject[] | undefined;  // children array
};

type SerializedObjectProps = KeyedObject;
```

Common keys observed in props:
- `name: string` (always serialized)
- `__description: string` (free-text doc)
- `__prefabPivot: 'left-top' | 'center' | ...`
- Dot-notation: `'pivot.x', 'pivot.y', 'scale.x', 'scale.y', 'style.fontSize', 'style.align'`
- Override prop strings include array callbacks: `['this.method', 'this.other,arg']`

## NodeExtendData (editor metadata, 61 properties)

`thing-editor/src/editor/editor-env.d.ts` L96-157:

```typescript
interface NodeExtendData {
  // Tree visibility
  hidden?: true;
  childrenExpanded?: boolean;
  
  // Hierarchy metadata
  deepness?: number;
  isSelected?: boolean;
  
  // UI references
  treeNodeView?: TreeNode;
  
  // Prefab system
  isPrefabReference?: string;            // if truthy: prefab name
  childrenContainer?: Container;
  
  // Serialization tracking
  constructorCalled?: boolean;
  
  // Unknown/legacy classes
  unknownConstructor?: string;
  unknownConstructorProps?: SerializedObjectProps;
  
  // Unknown/legacy prefabs
  unknownPrefab?: string;
  unknownPrefabProps?: SerializedObjectProps;
  
  // Preview mode
  component_in_previewMode?: boolean;
  
  // Serialization control
  noSerialize?: boolean;
  serializationCache?: SerializedObject;
  
  // Isolation
  isolate?: boolean;
  
  // Fader system
  isFaderShootCalledForThisFader?: boolean;
  
  // Props editor filtering
  hidePropsEditor?: {
    title: string;
    visibleFields: KeyedMap<true>;
  };
  
  // Caching
  tmpGlobalPos?: Point;
  
  // Status tracking
  statusWarnOwnerId?: number;
  objectDeleted?: string;                // deletion reason
  
  // Reference validation
  __allRefsDeletionValidator?: number;
  
  // Clone & preview state
  __isJustCloned?: boolean;
  __isPreviewMode?: boolean;
  
  // Debugging
  __pathBreakpoint?: any;
  
  // State flags
  isTypeChanging?: boolean;
  __fragmentOwnerId?: number;
  eatenRotation?: number;
}
```

`EMPTY_NODE_EXTEND_DATA` constant assigned post-destroy (Lib L1181).

## EditablePropertyDescRaw (decorator input)

editor-env.d.ts L27-82 — see references/04-authoring.md for full options list.

## EditablePropertyDesc (finalized)

L84-93:
```typescript
interface EditablePropertyDesc<T extends Container = Container> extends EditablePropertyDescRaw<T> {
  class: SourceMappedConstructor;        // owner class
  type: EditablePropertyType;            // required
  default: any;                          // required
  name: string;                          // required
  __src: string;                         // source location (for "Go to property definition")
  __nullCheckingIsApplied?: true;
  renderer?: any;
  isTranslatableKey?: boolean;
}
```

## EditablePropertyType

L197-218:
```typescript
type EditablePropertyType = keyof IEditablePropertyType;

interface IEditablePropertyType {
  'data-path': true; 'splitter': true; 'rect': true; 'callback': true;
  'l10n': true; 'timeline': true; 'ref': true; 'btn': true;
  'color': true; 'boolean': true; 'string': true; 'prefab': true;
  'pow-damp-preset': true; 'spine-sequence': true; 'number': true;
  'slider': true; 'image': true; 'sound': true; 'resource': true;
  'curve': true;
}
```

## SelectableProperty (chooser markers)

L231-239:
```typescript
interface SelectableProperty extends AnyType {
  ___EDITOR_isHiddenForChooser?: true | string;
  ___EDITOR_isHiddenForCallbackChooser?: true;
  ___EDITOR_isHiddenForDataChooser?: true;
  ___EDITOR_isGoodForChooser?: true;
  ___EDITOR_isGoodForCallbackChooser?: true;
  ___EDITOR_ChooserOrder?: true;
  ___EDITOR_actionIcon?: ComponentChild;
  ___EDITOR_callbackParameterChooserFunction?: (owner: any) => Promise<any[] | any>;
}
```

## IGoToLabelConsumer

L220-224:
```typescript
interface IGoToLabelConsumer {
  gotoLabel(label: string): void;
  gotoLabelRecursive(label: string): void;
  __getLabels(): undefined | string[];
}
```

Implementers: MovieClip, Spine, Container (no-op base).

## ProjectDesc (ProjectDesc.d.ts 74 lines)

```typescript
interface ProjectDesc {
  // Identity
  id: string;
  title: string;
  icon: string;
  
  // Scenes
  mainScene: string;                     // @deprecated use scenes[1]
  preloadScene: string;                  // @deprecated use scenes[0]
  scenes: string[];
  dir: string;                            // auto-set by fs
  
  // Rendering
  defaultFont: string;
  jpgQuality: number;                     // 0-100
  
  // Screen dimensions
  screenOrientation: 'landscape' | 'portrait' | 'auto';
  mobileOrientation: 'landscape' | 'portrait' | 'auto';
  width: number;                          // landscape
  height: number;
  portraitWidth: number;
  portraitHeight: number;
  
  // Quality
  renderResolution: number;
  renderResolutionMobile: number;
  framesSkipLimit: number;                // default 4
  dynamicStageSize: boolean;
  preventUpscale: boolean;
  
  // Build
  __buildConfigDebug: string;
  __buildConfigRelease: string;
  
  // Web fonts
  webfontloader: {
    custom?: { families: string[] };
    google?: { families: string[] };
    timeout: number;
  } | null | WebFont.Config;
  fontHolderText: string;
  
  // Textures
  mipmap: false;
  
  // Versioning
  version: string;
  
  // Sounds
  soundFormats: string[];
  soundDefaultBitrate: number;            // 8-256 kbps
  soundBitRates: KeyedMap<number>;
  loadOnDemandSounds: KeyedMap<number>;   // bit flags
  loadOnDemandTextures: KeyedMap<number>; // bit flags (see assets-lib.md)
  lowQualityVariants: KeyedMap<string>;
  defaultMusVol: number;
  defaultSoundsVol: number;
  
  // Localization
  embedLocales: boolean;
  __localesNewKeysPrefix: string;
  __doNotAutoCreateLocalizationFiles: string;
  defaultLanguage: string;
  
  // Warnings
  __suspendWarnings: number[];            // error codes to suppress
  
  // Fullscreen
  autoFullScreenDesktop: false;
  autoFullScreenMobile: false;            // (effectively true)
  
  // Network
  __proxyFetchesViaNodeServer: false;
  
  // Organization
  __group: string;                        // grouping path in UI
  libs: string[];
  
  // Scaling
  scaleMode: 'expand' | 'contain';
  
  // Cloud assets
  prefixResourcesName: string;
  availablePrefixResourcesName: string[];
  cloudAssetKeys: KeyedMap<string>;       // local name → cloud key
  cloudAssetsUrl?: string;
  
  // Localization variables
  globalLocalizationConfig?: GlobalLocalizationConfig;
}

interface GlobalLocalizationConfig {
  variables: KeyedMap<string>;
  enabled: boolean;
  lastModified?: number;
}
```

## AssetType + extension map

```typescript
enum AssetType {
  IMAGE = 'IMAGE',          // .png/.jpg/.svg/.webp
  SOUND = 'SOUND',          // .wav
  SCENE = 'SCENE',          // .s.json
  PREFAB = 'PREFAB',        // .p.json
  CLASS = 'CLASS',          // .c.ts
  RESOURCE = 'RESOURCE',    // .json
  BITMAP_FONT = 'BITMAP_FONT', // .xml
  L10N = 'L10N',            // .l.json
  FONT = 'FONT'             // .woff/.woff2
}
```

Extension crop lengths (fs.ts L121-130):
- SCENE 7, PREFAB 7, L10N 7, RESOURCE 5, CLASS 5
- IMAGE 0 (preserves full filename)

## FileDesc family

```typescript
interface FileDesc {
  fileName: string;
  assetName: string;
  assetType: AssetType;
  lib?: LibInfo;
}

interface FileDescImage extends FileDesc { /* +sprite sheet info */ }
interface FileDescPrefab extends FileDesc { asset?: SerializedObject; }
interface FileDescScene extends FileDesc { asset?: SerializedObject; }
interface FileDescSound extends FileDesc { duration?: number; bitRate?: number; }
interface FileDescL10n extends FileDesc { lang?: string; }
interface FileDescClass extends FileDesc { asset?: SourceMappedConstructor; }
```

## AssetsDescriptor (build output)

```typescript
interface AssetsDescriptor {
  scenes: KeyedMap<SerializedObject>;
  prefabs: KeyedMap<SerializedObject>;
  images: string[];
  resources?: string[];
  xmls?: string[];                       // bitmap fonts
  fonts?: string[];
  sounds: SoundAssetEntry[];             // [name, duration]
  text?: KeyedObject;                    // embedded locales
  projectDesc?: ProjectDesc;
}

type SoundAssetEntry = [soundName: string, duration: number];
```

## CallBackParsedData

```typescript
type CallBackParsedData = {
  p: (string | { c: string })[];  // path segments; {c: 'name'} for # child lookup
  v?: any[];                       // call parameters
};
type CallBackPath = string;
type ValuePath = string;
```

## SerializedDataValidationError

```typescript
type SerializedDataValidationError = undefined | {
  message: string;
  findObjectCallback: ((o: Container) => boolean | undefined);
  fieldName?: string;
  errorCode?: number;
};
```

## SourceMappedConstructor / GameClasses

```typescript
type SourceMappedConstructor = typeof DisplayObject;

// Generated at runtime, see references/06-editor.md
interface GameClasses {
  [key: string]: SourceMappedConstructor;
  'ClassName': typeof ClassName;
  // ...
}
```

## ThingSceneAllMap (generated)

```typescript
// Generated current-scene-typings.d.ts
declare global {
  type CurrentSceneType = MainSceneClassName;
  interface ThingSceneAllMap {
    [key: string]: Container;
    'namedObject1': SpecificClass;
    /** @deprecated Refused because N objects with that name */
    'duplicate': SomeClass;
  }
}
```

Accessed via `game.all.objectName` (typed). `_refreshAllObjectRefs()` in Scene populates.

## LocalizationKeys (generated)

```typescript
// localization-typings.d.ts
interface LocalizationKeys {
  (id: 'ui.take', values?: KeyedObject | number): string;
  (id: 'gameType.durak_podkidnoi', values?: KeyedObject | number): string;
  // ... overload per key
}
```

L() takes typed key + optional params.

## Electron bridge

```typescript
type Electron_ThingEditorServer = {
  fs: (command: string, filename?: string | string[] | number, content?: string | boolean, ...args: any[]) => FSCallback;
  fsAsync: (command: string, filename?: string | string[], content?: string | boolean, ...args: any[]) => Promise<any>;
  versions: KeyedObject;
  onServerMessage: (cb: (event: string, ...args: any[]) => void) => void;
  argv: string[];
};

type FSCallback = Uint8Array | undefined | FileDesc[] | ProjectDesc[] | number | boolean;
```

Exposed on `window.electron_ThingEditorServer`.

## SelectEditorItem

```typescript
interface SelectEditorItem {
  name: string;
  value: any;
  pow?: number;          // pow-damp-preset specific
  damp?: number;
}
```

## TimelineSerializedData (recap)

See references/05-animation.md for full schema.

```typescript
interface TimelineSerializedData {
  l: KeyedMap<number>;          // label → time
  f: TimelineSerializedFieldData[];
  p: number;                    // pow
  d: number;                    // damp
}

interface TimelineSerializedFieldData {
  n: string;                    // property name
  t: TimelineSerializedKeyFrame[];
}

// Partial<TimelineKeyFrame>
type TimelineSerializedKeyFrame = {
  t: number; v: any;
  m?: TimelineKeyFrameType; j?: number;
  s?: number; r?: number; a?: string;
  g?: number; b?: number;
};
```

## SerializedCurve

```typescript
interface SerializedCurve {
  k: CurveKeyFrame[];
  p?: number;            // default 0.2
  d?: number;            // default 0.85
}

interface CurveKeyFrame {
  t: number;             // 0-1
  v: number;
  m: CurveKeyFrameMode;  // LINEAR | SMOOTH | DISCRETE
}
```

## SelectionData / SelectionPath

```typescript
interface SelectionPathEntry {
  n: string | null;       // node name
  i: number;              // index among siblings with same name
}

type SelectionPath = SelectionPathEntry[];

interface SelectionData extends SelectionDataBase {
  _stageX?: number;
  _stageY?: number;
  _stageS?: number;
}
```

## HistoryRecord

```typescript
interface HistoryRecord {
  treeData: HistorySerializedData;
  fieldName: string | null;
  selectionData: SelectionData;
  _isModified?: boolean;
}
```

## CloudAssetData

```typescript
interface LanguageData {
  localeCode: string;
  localeLabel: string;
  routeParam: string;
}

interface CloudAssetData {
  imageUrl?: string;
  jsonUrl?: string;
  atlasUrl?: string;
  locale?: LanguageData;
  type?: 'IMAGE' | 'SPRITE_SHEET' | 'SPINE' | 'UI' | 'LOCALE';
}

interface ICloudAssetParser {
  parse(data: any): Map<string, CloudAssetData>;
  parseLanguages?(data: any): LanguageData[];  // deprecated
}
```

## Hotkey

```typescript
interface Hotkey {
  key: string;
  ctrlKey?: true;
  altKey?: true;
  shiftKey?: true;
}
```

`isHotkeyHit(ev, element, hotkey)` — blocks if text selected, blocks non-F1 if modal open, case-insensitive key, exact modifiers.

## ThingGameEvents (window events)

```typescript
interface ThingGameEvents {
  'game-will-init': [];
  'stage-will-resize': [];
  'preloader-scene-will-start': [];
  'global-update': [];
  'update': [];
  'updated': [];
  'mainSceneLoaded': [];
  'onSoundsLoaded': [];
  'onLODUpgradeComplete': [];
  'onLanguageChanged': [languageId: string];
  'onThemeChanged': [themeId: string];
  '__sound-overridden'?: [soundId: string];  // EDITOR
}
```

## KeyedMap / KeyedObject

```typescript
type KeyedMap<T> = { [key: string]: T };
type KeyedObject = { [key: string]: any };
```

## GameData (extensible by projects)

```typescript
interface GameData { }  // empty in editor-env, projects extend
```

Used as `game.data` for data-path system.

## LibInfo

Editor-side per-lib metadata:
```typescript
interface LibInfo {
  dir: string;
  assetsDir: string;
  libNum: number;
}
```

`editor.currentProjectLibs: LibInfo[]`

## Templates substitutions

```
NEW_CLASS_NAME → entered class name
BASE_CLASS_NAME → selected parent
BASE_CLASS_PATH → parent source path (no .ts)
CURRENT_PROJECT_DIR → /games/{projectDir}
```

## Schema (thing-project.json validation)

`thing-editor/src/editor/schema-thing-project.json` (347 lines) — full JSON Schema draft-04 for project descriptor. See `references/01-runtime.md` and ProjectDesc above for field semantics. Editor merges with per-lib `schema-thing-project.json` files.
