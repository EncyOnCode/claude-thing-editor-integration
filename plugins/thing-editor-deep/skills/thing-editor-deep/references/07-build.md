# Build pipeline + Electron main + ifdef preprocessor

## ifdef preprocessor

`thing-editor/electron-main/vite-plugin-ifdef/if-def-loader.{mjs,js}`:

```javascript
vitePluginIfDef(isDebug, isEditor = false)
```

Regex L3-5:
- `fileRegex = /\.(ts)$/`
- `editorImportRegex = /^import.*((thing-editor\/src\/editor\/)|(from "preact"))/`

Directives:

**`/// #if EDITOR`** L73, L82:
- If `!isEditor` → `cuttingLevel++` → block prepended with `///` per line

**`/// #if NOT-EDITOR`** L82, L92:
- If `isEditor` → cuts block

**`/// #if DEBUG`** L91, L102:
- If `!isDebug` → cuts block

**`/// #endif`** L110-124, L99-113:
- Validates stack not empty (throws on mismatch)
- Pops directive; decrements `cuttingLevel` if the inverse condition was true on opening
- **No `/// #else` support**

Implementation:
- Per-line mapping; if `cuttingLevel > 0` prepends `///`
- Nested via `cuttingStack: [directive, lineNumber][]`

**Additional preprocessing** L54-77:
- `@editable(...)` decorator: commented in production (multiline paren-balanced parse)
- Editor imports (preact, `thing-editor/src/editor/*`): commented unless `import type`
- `assert(...)` statements: commented if `!isDebug`

**Production import check** L25-31:
- If `!isEditor` AND import resolves into `thing-editor/src/editor/`: throws build error

## Build flag matrix

| Mode | isDebug | isEditor | Config | Output |
|------|---------|----------|--------|--------|
| Dev Editor | true | true | vite.config.js | dev :5173 |
| Prod Build | false | false | build-config.js | release/ |

## Vite dev config (`vite.config.js`)

```javascript
{
  json: { stringify: true, namedExports: false },
  server: {
    hmr: false,                              // electron doesn't support HMR
    watch: IS_CI_RUN ? {ignored:['**/**']} : {ignored:['**/node_modules/**', '/**/.tmp/**', 'games/**/debug/**', 'games/**/release/**']},
    strictPort: 5173
  },
  plugins: [
    ifDefPlugin(true, true),                 // isDebug=true, isEditor=true
    resolver
  ],
  esbuild: { keepNames: true },
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json', '.jsx', '.tsx'],
    dedupe: ['thing-editor/**'],
    preserveSymlinks: true,                  // CRITICAL for monorepo
    alias: {
      libs: __dirname + '/libs',
      games: __dirname + '/games',
      'thing-editor': __dirname + '/thing-editor',
      'pixi.js': __dirname + '/node_modules/pixi.js/dist/pixi.mjs'
    }
  },
  define: {
    SPINE_SRC_PATH: JSON.stringify('/node_modules/pixi-spine/dist/pixi-spine.js'),
    global: 'window'
  },
  optimizeDeps: { include: ['@pixi/particle-emitter'] }
}
```

## Production build config (`electron-main/build-config.js`)

Factory `(root, publicDir, outDir, debug, projectDesc) => viteConfig`:

```javascript
{
  root,                                       // .tmp
  publicDir,                                  // .tmp/public
  base: './',                                 // relative asset paths
  esbuild: { keepNames: true, target: 'ES2015' },
  plugins: [
    ifDefPlugin(debug),                       // isEditor defaults false
    ViteImageOptimizer({ jpg: { quality: projectDesc.jpgQuality } })
  ],
  build: {
    target: 'ES2015',
    minify: !debug,
    emptyOutDir: true,
    outDir,                                    // <project>/release or /debug
    rollupOptions: { input: '' }
  },
  resolve: {
    alias: {
      'games': '../../games',
      '.tmp': '../../.tmp',
      'libs': '../../libs',
      'thing-editor': '../../thing-editor',
      'howler.js': 'https://cdn.jsdelivr.net/npm/howler@2.2.3/dist/howler.min.js',
      'pixi.js': 'https://cdn.jsdelivr.net/npm/pixi.js@7.2.4/dist/pixi.min.mjs'
    }
  },
  define: {
    SPINE_SRC_PATH: '"https://cdn.jsdelivr.net/npm/pixi-spine@4.0.4/dist/pixi-spine.js"'
  }
}
```

**Note:** Prod uses **jsDelivr CDN** for pixi + howler + pixi-spine — offline builds break.

## Build orchestration (`utils/build.ts` 640 lines)

`Build.build(debug?, buildAndRun?)` L145-204:
1. Show spinner, backup projectDesc
2. `callPrebuildScripts()` — spritesheet/low-quality builders register here
3. `validateResources()` L157
4. `generateAssetsList()` L172 categorizes assets:
   - preloader: themes/, preloader-assets/, fonts
   - main: everything else
   - delayed: lowQualityVariants[]
5. `saveAssetsDescriptor()` writes `.tmp/assets-{preloader,main,delayed}.json`
6. `addGeneratedSpritesheetsToBuild()` — integrates spritesheet-builder output
7. `addGeneratedLowQualityTexturesToBuild()` — integrates LQ output
8. `createClassesFile()` L232-300 generates `.tmp/classes.ts` (filters referenced, handles `__requiredComponents`, alphabetical sort)
9. `createIndexHTML()` L302-315 copies + patches index.html
10. `fs.build()` invokes electron-main build.js → vite.build()
11. Finalize, restore projectDesc

**Asset prefix filtering:**
- Release: strips `___`-prefixed
- Debug: strips `__`-prefixed (keeps `___` for debugging)

**Pre/post-build callbacks:**
- `addPreBuildScript(callback, id)` / `addPostBuildScript(callback, id)`
- Used by spritesheet-builder + low-quality-builder

## Build dialog (`utils/build-dialog.ts` 303 lines)

`BuildDialog.showBuildDialog()` modal:

UI inputs L36-172:
- Version (string)
- Include build number checkbox + number input (Unix ts)
- Include date checkbox (YYYYMMDD)
- Release build checkbox (false=debug)
- Build & Run checkbox
- Mobile orientation: auto/portrait/landscape

Real-time preview updates as user types.

`executeBuild(options)` L188-208:
- Updates `projectDesc.version`
- Saves projectDesc to disk
- Updates `projectDesc.mobileOrientation`
- Calls `Build.build(!options.isRelease, options.buildAndRun)`

## electron-main/build.js (`thing-editor/electron-main/build.js`)

`build(projectDir, debug, assetsToCopy, projectDesc)` L7:

1. Setup paths L8-13:
   - `editorRoot = .../thing-editor/..`
   - `tmpDir = /.tmp`
   - `projectRoot = ../[projectDir]`
   - `outDir = [projectRoot]/debug` or `/release`
   - `publicDir = /.tmp/public`
   - `publicAssetsDir = /.tmp/public/assets/`

2. Clean L15-29:
   - rm `.tmp/public` recursive
   - unlink files in outDir (no dir remove)
   - recreate publicDir + publicAssetsDir

3. Asset copy L31-68 (Promise.all):
   - For each: ensure directory exists
   - If !debug && `.json`: minify via `JSON.parse(...)` → `JSON.stringify(...)`
   - Else: `fs.copyFile` with retry on error

4. Vite build L69-88:
   - Loads config from `projectDesc.__buildConfigDebug` or `__buildConfigRelease`
   - `require('vite').build(config)`
   - On success: `'BUILD COMPLETE: http://localhost:5174/' + projectDir`
   - Triggers `static-server.js` startup
   - On error: returns error object

## electron-main/build-sounds.js

Transcodes `.wav` → multiple formats (mp3/webm/ogg).

1. Load cache `~snd-convert-cache.json` from sounds dir L35-40
2. Walk for `.wav` files (excludes `~` prefix)
3. For each: check if all target formats exist
4. Compare mTime + file hash → push to `filesToConvert[]`
5. Parallel Promise.all per file × format L81-88
6. `convertFile(fileData, ext)` L105-169:
   - Locate ffmpeg/ffprobe (`.bin/ffmpeg/` or PATH)
   - Cmd: `ffmpeg -i [wav] [bitrate] [output]`
   - For `.webm`: add `-dash 1`
   - Bitrate from `options.bitRates[filename]` or default
   - Get duration via ffprobe
   - Retry 5× on EACCES (file locked), 1s intervals
7. Write cache with `{mTime, bitrate, hash, duration}`

## electron-main/index.js (entry point)

L14-23: Single-instance lock via `app.requestSingleInstanceLock()`. Second-instance focuses existing window.

L25-39: `isClosingBlocked()` shows dialog if progress operation in flight.

L41-47: Console override (safe wrapping).

L49: `IS_DEBUG = process.argv.includes('debugger-detection-await')`

L71-82 BrowserWindow:
```javascript
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  additionalArguments: ['--user-data-dir=' + path.join(os.tmpdir(), 'chrome-user-tmp-data')],
  webSecurity: false
},
icon: './thing-editor/img/favicon.ico'
```

L88-100: External links open in browser via `setWindowOpenHandler`.

L102-111: F5 reload registered on focus, unregistered on blur.

L113-117: Close event preventDefault if blocked.

L119: `nativeTheme.themeSource = 'system'`

L121: `require('./server-fs.js')(mainWindow)`

L123-142: Vite editor URL: `'http://localhost:5173/thing-editor/'`
- Debug mode: loads `debugger-awaiter.html` first, then editor after 600ms
- Error handler for `ERR_CONNECTION_REFUSED`

## electron-main/thing-editor-window.js (36 lines)

```javascript
module.exports = function getPositionRestoreWindow(windowState, id) {
  const stateId = 'windowPosition-' + id;
  if (appConfig.has(stateId)) {
    windowState = Object.assign({}, appConfig.get(stateId), windowState);
  }
  const window = new BrowserWindow(windowState);
  if (IS_CI_RUN) window.minimize();
  else if (windowState.isMaximized) window.maximize();
  
  const saveWindowPos = () => {
    appConfig.set(stateId, Object.assign(window.getBounds(), {isMaximized: window.isMaximized()}));
  };
  window.on('moved', saveWindowPos);
  window.on('maximize', saveWindowPos);
  window.on('resized', saveWindowPos);
  saveWindowPos();
  return window;
};
```

Uses `electron-settings` for persistence.

## electron-main/preload.js (25 lines)

```javascript
contextBridge.exposeInMainWorld('electron_ThingEditorServer', {
  versions: { node: process.versions.node, chrome: process.versions.chrome, electron: process.versions.electron },
  fs: (command, fileName, content, ...args) => ipcRenderer.sendSync('fs', command, fileName, content, ...args),
  fsAsync: (command, fileName, content, ...args) => ipcRenderer.invoke('fs', command, fileName, content, ...args),
  onServerMessage: (cb) => ipcRenderer.on('serverMessage', cb)
});
```

## electron-main/launch-if-stopped.js (25 lines)

Spawns detached Electron with debugger:
```javascript
child_process.spawn(command, [
  '--remote-debugging-port=9223',
  './thing-editor/electron-main',
  'debugger-detection-await'
], {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
  windowsHide: false,
  cwd: process.cwd()
});
```

Command: Windows = `./node_modules/electron/dist/electron.exe`, else `./node_modules/.bin/electron`.

## electron-main/editor-server-utils.js (23 lines)

```javascript
const walkSync = (dir, fileList = []) => {
  fs.readdirSync(dir).forEach(file => {
    if (!file.startsWith('~')) {
      const fullPath = path.join(dir, file);
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        fileList = walkSync(fullPath, fileList);
      } else if (stats.size > 0) {
        fileList.push({fileName: fullPath.replaceAll(path.sep, '/'), mTime: stats.mtimeMs});
      }
    }
  });
  return fileList;
};
```

## electron-main/server-fs.js

IPC handlers:

| Command | Effect |
|---------|--------|
| `fs/saveFile` | Write file (detects data URLs for base64 images, minifies JSON if !debug) |
| `fs/delete` | Remove file |
| `fs/readFile` / `fs/readFileIfExists` | Read or null |
| `fs/readDir` | Walk + optional per-project `assets-loader.cjs` hook |
| `fs/copyFile` | Copy with mkdir |
| `fs/exists` | Boolean check |
| `fs/watchDirs` | Start chokidar watchers |
| `fs/build` | Invokes `build.js` |
| `fs/run` | `require()` + execute arbitrary module |
| `fs/getFileHash` | MD5 base64 truncated 8 chars |
| `fs/enumProjects` | List projects |
| `fs/sounds-build` | Invokes `build-sounds.js` |

## electron-main/watch.js

`chokidar` watcher. Ignores `***___editor_backup_*` and `~*` files.
Emits `add`, `change`, `unlink` → IPC `'serverMessage'` → `'fs/change'`.

## electron-main/static-server.js

Express server on port 5174, serves root, starts after build completes (`build.js` L80).

## electron-main/resolver/resolver.js

Vite plugin:
- L23-31 stubs `thing-editor/src/editor/prefabs-typing` to empty class export
- L41-65 query-string propagation: imports from `games/` and `libs/` get `?` query for cache-bust (`moduleImportFixer = /(^\s*import\s+[^"]*"[^"]+)(")/gm`)
- L12-18 CI throttling: 50ms request delay when `IS_CI_RUN=true` (prevents Chrome crash)

## electron-main/pixi-typings-patch.js

Injects engine method types into `@pixi/*` `.d.ts` files post-install.

Patches L9-166:
- `DisplayObject.d.ts`: getGlobalRotation, getScenePosition, getRootContainer, init, update, remove, onRemove, findParentByType, findChildByName, findChildrenByType, all serialization/editor hooks, __prefabPivot, __nodeExtendData, __hideInEditor
- `Sprite.d.ts`: image, _imageID, tintR/G/B
- `Mesh.d.ts`: image, _imageID, tintR/G/B
- `Text.d.ts`: setAlign, translatableText, textTransform, maxWidth
- `Container.d.ts`: replace T generic with concrete Container

Application L180-242:
- Walks from `thing-editor/thing-editor` upward to project root
- Idempotent via begin/end markers
- Skips already-patched files
- Warns if patch string not found

Skips if `IS_CI_RUN=true` L220-222.

## electron-main/enum-projects.js

Recursive scan `../../games/`:
- Skips `.git` and `node_modules`
- For each subdir: check for `thing-project.json`
- If found: parse JSON + add `dir` field to result
- If not: recurse

## Spritesheet builder (`utils/spritesheet-builder.ts` 562 lines)

```typescript
interface SpritesheetConfig {
  name: string;
  textures: string[];
  format: 'png' | 'webp';
  quality: number;
  enableLOD: boolean;
  lodScale: number;
}

interface GeneratedSpritesheet {
  name, imagePath, jsonPath, jsonData, hashedImageName, originalImageName, imageHash,
  lodImagePath?, hashedLodImageName?, lodImageHash?, lodScale?
}
```

Constants:
- `MAX_SHEET_SIZE = 2048`
- `PADDING = 2`
- `CONFIG_FILE_NAME = 'spritesheet-configs.json'`
- Output: `.cache/assets/`

Packing algorithm L150-214 — binary tree bin packing (Guillotine):
- Sort sprites by max(w,h) then area descending
- `findNode()` finds unused space
- `splitNode()` splits into used/down/right
- `growNode()` grows canvas
- Returns null if exceeds 2048×2048

Generation L320-431:
- Creates canvas, draws sprites
- PixiJS-compatible frame JSON L359-381
- webp uses quality/100, png default
- LOD: generates reduced-quality copy if enableLOD (lodScale affects quality, NOT dimensions)

Pre-build registration L436-559:
- `registerSpritesheetPreBuildScript()` clears previous generations
- Builds texture map from `fs.getAssetsList(AssetType.IMAGE)`
- Outputs to `.cache/assets/` with hashing
- Adds LOD mapping to `projectDesc.lowQualityVariants`
- Post-build deletes generated files L536-558

## Low quality builder (`utils/low-quality-builder.ts` 206 lines)

```typescript
interface LowQualityConfig {
  textureName: string;
  quality: number;  // 0-100
  scale: number;    // 0.1-1.0
  format: 'webp' | 'png';
}

interface LowQualityConfigs {
  defaults: LowQualityConfig;
  textures: string[];
}
```

Default: quality=50, scale=1.0, format='webp'.

`generateLqFileName(name)` appends `_lq` suffix.

`registerLowQualityPreBuildScript()` L107-176:
- Loads originals from file
- Calls `lowQualityTextureService.generateDataUrl()`
- Writes to `.cache/assets/` with _lq suffix
- Updates `projectDesc.lowQualityVariants`

Post-build L181-197: deletes generated, refreshAssetsList after 100ms.

## Low quality texture service (`utils/low-quality-texture-service.ts` 127 lines)

Canvas-based compression/scaling singleton:
- `generateDataUrl(source, options)` L57-68:
  - `targetWidth = sourceWidth * scale`
  - `imageSmoothingQuality = 'medium'` if scale<1 else 'low'
  - Returns canvas.toDataURL with quality

## Demo install (`demo/install.js` 24 lines)

`npm run dependencies`:
1. Patches pixi typings via `pixi-typings-patch.js`
2. Creates `./games` and `./libs` dirs if missing
3. Copies `.code-workspace.template` → `.code-workspace` (if not exists)
4. Copies `tsconfig.json.template` → `tsconfig.json` (if not exists)
5. Copies demo example-project + example-lib (force: false)

**Does NOT download ffmpeg** — user installs separately.

## index.html (21 lines)

```html
<link rel="stylesheet" href="./src/editor/themes/light/style.css">
<link rel="stylesheet" href="./src/editor/themes/light/style-timeline.css">
<link rel="stylesheet" href="./src/editor/themes/light/style-spine-sequence.css">
<script type="module" src="./src/editor/warnings-filter.ts"></script>
<script type="module" src="./src/editor/editor.ts"></script>

<div id="root"></div>
<div id="select-lists-root"></div>
<div id="context-menu-root"></div>
```

## debugger-awaiter.html (24 lines)

Holds JS engine open for debugger attachment:
```html
<body>
debugger await...
<script type="module">
  window.a = 0;
  window.setInterval(() => { window.a++; }, 10);
</script>
</body>
```

Strict CSP: `default-src 'self'; script-src 'self'`.

After 600ms, index.js loads main editor.

## tsconfig.json (key options)

```json
{
  "target": "ES2020",
  "module": "ESNext",
  "moduleResolution": "bundler",
  "allowImportingTsExtensions": true,
  "isolatedModules": true,
  "noEmit": true,
  "forceConsistentCasingInFileNames": false,
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noFallthroughCasesInSwitch": true,
  "experimentalDecorators": true,
  "paths": { "thing-editor": ["./thing-editor"] },
  "baseUrl": "./.",
  "include": ["**/*.mjs", "./games/", "./libs/", "thing-editor/src"]
}
```

Decorators enabled for `@editable`. `reflect-metadata` imported at game.ts top.

## CLI args (Editor)

Parsed in editor constructor L143-151:
- `--build-and-exit` → buildProjectAndExit
- `--no-vscode-integration` → skips typings generation
- `--key=value` syntax
- Stored in `editor.editorArguments: KeyedMap<true | string>`

`getArgs()` IPC returns `process.argv`.

## Build output structure

```
<project>/release/    (or debug/)
├── index.html
├── assets/
│   ├── (hashed image files)
│   ├── (hashed atlases)
│   ├── (hashed BMF + XML)
│   └── (hashed sounds in multi-format)
└── (Vite-bundled JS)
```

`.tmp/`:
```
.tmp/
├── classes.ts                  (generated bundled class index)
├── assets-preloader.json       (preloader desc)
├── assets-main.json            (main desc)
├── assets-delayed.json         (delayed desc / LOD high-res)
└── public/assets/              (asset staging)
```
