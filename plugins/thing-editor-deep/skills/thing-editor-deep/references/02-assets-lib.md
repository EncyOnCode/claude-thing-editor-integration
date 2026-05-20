# Lib + Assets + Cloud + Serialization

`thing-editor/src/engine/lib.ts` (~1850 lines)

## Module-level state

```
classes: GameClasses                          // L25 — registered classes
scenes: KeyedMap<SerializedObject>             // L26
prefabs: KeyedMap<SerializedObject>            // L27
staticScenes: KeyedMap<Scene>                  // L28
textures: KeyedMap<Texture>                    // L29
soundsHowlers: KeyedMap<HowlSound>             // L30 (aliased as Lib.sounds)
removeHoldersToCleanup: RemoveHolder[]         // L33
unHashedFileToHashed: Map<string, string>     // L35 — EXPORTED
```

## Lib static API surface

| Method | Lines | Purpose |
|--------|-------|---------|
| `ASSETS_ROOT` | 92 | `'./assets/'` |
| `loadScene(name)` | 112 | deserialize + cache static |
| `loadPrefab(name)` | 1782 | deserialize + constructRecursive |
| `_deserializeObject(src, isScene?)` | 840 | **core hydration engine** |
| `hasPrefab/hasScene/hasTexture` | 173-181 | existence checks |
| `addTexture(name, url\|Texture, attempt?)` | 286 | async load + cache |
| `addResource(name, url, attempt?, parentAsset?)` | 206 | sprite sheets/atlases |
| `getTexture(name)` | 416 | resolves via AssetsResolve |
| `addSound(name, url, duration)` | 655 | HowlSound register |
| `preloadSound(soundId, owner?)` | 672 | async start |
| `addAssets(data, assetsRoot?)` | 981 | bulk register from AssetsDescriptor |
| `unHashFileName(fileName, assetsRoot?)` | 1101 | strips hash, populates `unHashedFileToHashed` |
| `destroyObjectAndChildren(o, itsRootRemoving?)` | 1111 | recursive destroy + RemoveHolder defer |
| `_setClasses(classes)` | 154 | runtime path normalizes serialized data |
| `_cleanupRemoveHolders()` | 1194 | drains deferred destroy queue |
| `_loadClassInstanceById(id)` | 1200 | Pool.create from registry |
| `__savePrefab(o, name, libName?)` (EDITOR) | 1364 | serialize + fs.saveAsset |
| `__saveScene(scene, name)` (EDITOR) | 1346 | serialize + fs.saveAsset |
| `__serializeObject(o)` (EDITOR) | 1243 | recursive serialize, caches in __nodeExtendData.serializationCache |
| `__invalidateSerializationCache(o)` (EDITOR) | 1332 | bubbles cache clear up to game.stage |
| `__loadPrefabReference(prefabName)` (EDITOR) | 1389 | load as prefab ref instance |
| `__preparePrefabReference(o, name)` (EDITOR) | 1699 | flag `isPrefabReference`, hide children |
| `upgradeLODTextures()` | 503 | async LOD swap |
| `getDemandAssetsList()` | 426 | lazy-load registry |
| `loadTextureFromDemand(name)` | 472 | async lazy texture |
| `loadSpritesSheetFromDemand(name)` | 449 | async lazy atlas |

## Serialization format

```
{
  c?: 'ClassName',         // class (mutually exclusive with r)
  r?: 'prefabName',        // prefab reference (mutually exclusive with c)
  p: { ...props },         // ONLY non-default values
  ':': [ ...children ]     // children array
}
```

Special prop keys:
- `__prefabPivot`: `'left-top'` | `'center'` etc — preserved in prefab props (L1378)
- `__description`: free-text doc
- `name`: always serialized
- Dot-notation: `"pivot.x"`, `"pivot.y"`, `"scale.x"`, `"style.fontSize"` serialized verbatim
- Callbacks: `["this.method", "this.other,arg1,0xFF,true"]`
- Path strings: `"this.#childName"`, `"all.namedObject"`, `"data.field"`
- `___`-prefixed keys filtered out by `fs.fieldsFilter` (never serialized)

## Deserialization flow

`_deserializeObject(src, isScene?)` L840:

**Prefab reference path** L851-873:
1. Check `src.r` exists in `prefabs` dict; fallback to `'___system/unknown-prefab'` if missing
2. Recursively deserialize the referenced prefab data
3. `Object.assign(ret, src.p)` (override props from caller)
4. EDITOR: sets `__nodeExtendData.isPrefabReference = prefabName`, hides children

**Class instance path** L875-924:
1. Look up `src.c` in `classes` registry; fallback to `__UnknownClass` if missing
2. EDITOR: Pool.create + `__beforeDeserialization` hook + merge defaults + props + unknown tracking
3. Runtime (L921-922): simplified `Pool.create(src.c)` + `Object.assign(ret, src.p)`
4. Editor stores `__nodeExtendData.unknownConstructor` + `unknownConstructorProps` if class missing

**Children** L925-954:
- iterates `src[':']` array
- editor filters static triggers via `_filterStaticTriggers` (L1802)
- recursively deserializes each, addChild to parent

**Post** L959:
- depth=0: calls `processAfterDeserialization` hooks
- if Scene + !EDITOR_mode + isStatic: stores in `staticScenes[name]` (L149)

`constructRecursive(o)` (runtime only, L1452):
- sets `_thing_initialized = true`
- calls `o.init()`
- validates super.init() was called (editor)
- recurses children

## Loader hacks (runtime-only)

`_initParsers()` L38-80, only runs when NOT EDITOR (L82-84):

**Spritesheet** L38-63:
- wraps `Assets.loader.parsers.find(p => p.name === 'spritesheetLoader').parse`
- extracts `asset.meta.image` (the spritesheet image filename inside the JSON)
- resolves to asset name relative to ASSETS_ROOT
- checks `game.projectDesc.lowQualityVariants` for LOD override
- **looks up `unHashedFileToHashed.get(url)`** — throws if missing
- rewrites `asset.meta.image` with hashed filename before original parser sees it

**Bitmap font** L65-79:
- wraps `loadBitmapFont.parse`
- regex `/(file=")([^"]+)(")/gm` finds `file="..."` in BMF XML
- reconstructs full path, looks up in `unHashedFileToHashed`, replaces

## Hashed filename system

`unHashFileName(fileName, assetsRoot)` L1101:
- format: `prefix-{8charhash}.{ext}` → `prefix.{ext}`
- side effect: `unHashedFileToHashed.set(assetsRoot + unhashedName, fileName)`
- called during `addAssets` for every image/resource/sound

`getHashedFileName(assetName, assetType?)` L967 (editor): fs lookup → file.fileName

## Texture settings bitmap (`projectDesc.loadOnDemandTextures` values)

| Bit | Meaning |
|-----|---------|
| 1 | load-on-demand |
| 2 | load-on-demand with early pre-cache |
| 4 | generate mipmaps |
| 8 | wrap REPEAT |
| 16 | wrap MIRRORED_REPEAT |

`_getTextureSettingsBits(name, mask)` L375
`_applyTextureSettings(name)` L380: applies wrap mode + mipmap

## Texture cache + lifecycle

- `textures: KeyedMap<Texture>` module dict
- `REMOVED_TEXTURE: Texture` (L100) — fallback placeholder
- `addTexture` L286: `Texture.fromURL`, retry up to 3× with exponential backoff
- Editor: updates baseTexture in-place if exists; runtime: assigns
- `_unloadTexture(name)` L185: `Texture.removeFromCache + destroy baseTexture`
- `__deleteTexture(name)` L1406 (editor): replaces with REMOVED_TEXTURE, preserves updateID

## LOD (Level of Detail) flow

State L109-110:
```
_lodPendingUpgrade: KeyedMap<{highResUrl, lodScale}>
_lodUpgradeInProgress: boolean
```

- `hasLODPendingUpgrade()` L495
- `upgradeLODTextures()` async L503: iterates pending, `_upgradeSingleLODTexture` each, emits `'onLODUpgradeComplete'`
- `_upgradeSingleLODTexture(lodName, highResUrl, lodScale)` L544:
  - loads high-res
  - finds existing LOD texture in cache
  - **swaps baseTexture** on derived textures sharing it (L575-584)
  - re-applies texture settings
  - emits `'loaded-resource-texture'` + base name
  - destroys old baseTexture

`addAssets` LOD logic L1001-1061:
- detects LOD: `game.projectDesc.lowQualityVariants[fileName]` exists
- if is LOD: sets `fileName = highResFileName`
- skips load if high-res has pending upgrade
- `_registerLODForUpgrade()` registers for later

## On-demand asset loading

`_ondemand: KeyedMap<string>` L105 — name → hashed URL

`addAssets` L1035-1083: if texture bit 1-2 set:
- bit 2: `addTexture` called immediately (early pre-cache)
- else: placeholder REMOVED_TEXTURE in editor

`getDemandAssetsList()` L426: returns `{name, url, format: 'IMAGE'|'ATLAS'}[]`
`loadTextureFromDemand(name)` L472 async
`loadSpritesSheetFromDemand(name)` L449 async

`_getAssetFormat(asset)` L1189:
- `.png/.jpg/.jpeg/.gif/.svg/.webp` → IMAGE
- else → ATLAS

## Cloud assets

`thing-editor/src/engine/utils/assets-resolve.ts`:

`AssetsResolve` class — singleton (L8, getInstance L23-29):
- constructor takes `prefixName`, instantiates `DefaultCloudParser`
- `setPrefixName(name)` L35-42: saves to `projectDesc.prefixResourcesName`
- `initCloudAssets(assetsUrl)` async L103-119: fetches JSON, parses via parser
- `static getAvailableLanguages()` L125-132: filters `type === 'LOCALE'`
- `static getTextureName(textures, name)` L53-81:
  1. check cloud WITHOUT prefix
  2. check local WITH prefix
  3. check local WITHOUT prefix
  - falls back to `REMOVED_TEXTURE.clone()` in editor
- `static getPrefabName(prefabs, name)` L83-89
- `resolveTextureUrl(fileName, defaultUrl)` L140-152: cloud > default
- `resolveResourceUrl(fileName, defaultUrl)` L160-195: returns `{url, metadata: {textureUrl|spineAtlasFile|spineTextureFiles}}` for SPRITE_SHEET/SPINE
- `getCloudKey(fileName)` L202-207: reverse lookup `projectDesc.cloudAssetKeys`
- `refreshTextures()` (EDITOR) L217-228: force reload via `_imageID` toggle

`cloud-asset-parser.interface.ts`:
```typescript
type AssetType = 'IMAGE' | 'SPRITE_SHEET' | 'SPINE' | 'UI' | 'LOCALE';

interface CloudAssetData {
  imageUrl?: string;
  jsonUrl?: string;
  atlasUrl?: string;
  locale?: { localeCode, localeLabel, routeParam };
  type?: AssetType;
}

interface ICloudAssetParser {
  parse(data: any): Map<string, CloudAssetData>;
  parseLanguages?(data: any): LanguageData[]; // deprecated
}
```

`DefaultCloudParser` L42-89:
- recursively walks `data.assetsTree`
- looks at `item.infoImage.type`
- IMAGE: `item.image[0].url`
- SPRITE_SHEET: + `item.json[0].url`
- SPINE: + `item.atlas[0].url` + `item.json[0].url`
- UI: `item.json[0].url`

ProjectDesc fields:
- `cloudAssetsUrl?: string` — API endpoint
- `cloudAssetKeys: KeyedMap<string>` — cloud key → local asset name

## Class registry

`_setClasses(_classes)` L154:
- sets module `classes`
- syncs `game._setClasses`
- **runtime only**: calls `normalizeSerializedData()` (L160) to flatten prefab refs
- DEBUG: validates no editor-only methods in runtime classes

`__UnknownClass` (`thing-editor/src/editor/utils/unknown-class.ts`):
- extends Container
- `__defaultValues = {}`
- `__EDITOR_icon = 'tree/unknown-class'`
- Used when `src.c` not found in registry
- State preserved in `__nodeExtendData.unknownConstructor` + `unknownConstructorProps`
- `__UnknownClassScene` variant for missing scenes

## Pool integration

`Pool.create(constructor)` lines 905, 921, 1207 — instantiate from pool
`Pool.dispose(o)` L1176 — return to pool
Contract: `__defaultValues` static dict per class (L898, 915, 1208, 1500)
Runtime path L921-922: `Pool.create(src.c) + Object.assign(ret, src.p)` faster than constructor

## Destruction flow

`destroyObjectAndChildren(o, itsRootRemoving?)` L1111:
1. Editor: exit preview mode, assert not removing during init, selection cleanup
2. Call `onRemove()`
3. Call `__beforeDestroy()` hook if exists
4. **If itsRootRemoving && !EDITOR_mode**: create RemoveHolder, replace in parent children array, push to `removeHoldersToCleanup`, detach parent
5. Else: detach from parent directly
6. Recursively destroy children
7. `Pool.dispose(o)`
8. Editor: reset __nodeExtendData to EMPTY, `markOldReferences()`

`_cleanupRemoveHolders()` L1194: drains `removeHoldersToCleanup` array, destroys each holder

`RemoveHolder` (`engine/utils/remove-holder.ts`):
- extends Container, `visible = false`
- `onRemove()` deregisters from `removeHoldersToCleanup`
- empty `update()` stub

## EDITOR_BACKUP_PREFIX

`'___editor_backup_'` (L9 in flags.ts) — for backup scenes during class reload, prefab edit.
- Backup scenes skip name persistence (L124, 1352, 1786)

## Asset event handlers

`__onAssetAdded(file)` L1569 (editor): fs callback
`__onAssetUpdated(file)` L1606
`__onAssetDeleted(file)` L1667
- Exported from lib.ts L1563
