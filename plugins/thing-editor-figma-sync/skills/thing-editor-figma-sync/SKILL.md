---
name: thing-editor-figma-sync
description: Sync Thing-Editor scene/prefab JSON to a Figma frame. Diff positions, sizes, colors, text. Patch .s.json/.p.json minimally. Use when user asks to align game UI to Figma design, fix offsets, missing pixels, color mismatches, or import design from Figma into a Thing-Editor scene.
---

# Thing-Editor ↔ Figma Sync

Pulls a Figma frame, diffs against a Thing-Editor `.s.json` / `.p.json`, patches the JSON in place. Match by name first, code-connect map second, manual third.

**Prerequisite skill:** `thing-editor` skill provides scene JSON format and gotchas. Load it if engine details needed.

## When to use

- "Match this scene to the Figma frame"
- "Fix offsets / pixel-perfect alignment to design"
- "Update colors/tints from Figma"
- "Import this Figma frame as a prefab"
- User pastes Figma URL + scene path

## Workflow

### 1. Pick Figma source (cost order: cheap → paid)

Prefer in this order:

1. **Framelink `figma-context-mcp`** (free, self-hosted, recommended).
   - Repo: https://github.com/glips/figma-context-mcp
   - Run via: `npx -y figma-developer-mcp --figma-api-key=$FIGMA_TOKEN --stdio`
   - Or register in `~/.claude.json` / project `.mcp.json`:
     ```json
     {
       "mcpServers": {
         "figma-framelink": {
           "command": "npx",
           "args": ["-y", "figma-developer-mcp", "--stdio"],
           "env": { "FIGMA_API_KEY": "figd_xxx" }
         }
       }
     }
     ```
   - Tools exposed: `get_figma_data` (node tree, layout, styles, text), `download_figma_images` (raster/SVG export).
   - Call shape: `get_figma_data({ fileKey, nodeId, depth? })`. nodeId format `1:23` (convert `-` to `:` from URL).
2. **REST script** `scripts/fetch-figma.mjs` — fully local, no MCP needed. Requires `FIGMA_TOKEN`. Use when MCP not configured or for batch/CI.
3. **Paid `mcp__plugin_figma_figma__*`** — last resort. Costs money. Only use if user explicitly asks for Code Connect / screenshot / advanced Figma write tools the free MCP lacks.

### 2. Fetch Figma frame

Via Framelink: call `get_figma_data` with fileKey + nodeId. Via REST: `node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/fetch-figma.mjs --url '<figma-url>' > /tmp/figma-snapshot.json`.

Need per node:
- `name` (matches scene object name)
- `absoluteBoundingBox` ({ x, y, width, height })
- `rotation` (degrees)
- `opacity`
- `fills[0].color` (RGBA 0-1) → tint hex
- `fills[0].imageRef` → texture name lookup
- `characters` + `style.fontSize` (text nodes)
- `visible`

Also grab parent frame box to compute relative coords.

### 3. Parse scene JSON

Run scene-walker:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/scene-walker.mjs <scene-path>
```
Outputs flat JSON map: `{ name: { path: [...], class: "...", props: {...} } }`.

`path` = JSON pointer chain through `:` arrays so patcher can locate the node.

### 4. Match nodes

Scene names are NOT guaranteed unique (e.g. per-seat `playerView` in card games). Use composite key.

Try in order:
1. **Composite key** `parentName/objectName` — ascend Figma parent chain to build same composite key.
2. **Full path key** — `grandparent/parent/name` if step 1 still ambiguous.
3. **Code-connect map**: `<project>/figma.connect.json` overrides; entry shape `{ "figmaNodeId": "1:23", "scenePath": [":", 0, ...] }`.
4. **Ask user** for unmapped layers.

Skip Figma layers prefixed `_` (design-only annotations).

Walker output `parentName` field used for composite. If multiple scene entries share full path, walker emits warn lines on stderr — surface them to user.

### 5. Compute diff

Per matched pair, build patch entries. **Coord conversion mandatory** — see `references/coord-mapping.md`.

Diff schema:
```json
[
  { "scenePath": "...", "prop": "x",       "from": 100, "to": 120 },
  { "scenePath": "...", "prop": "scale.x", "from": 1,   "to": 1.05 },
  { "scenePath": "...", "prop": "tint",    "from": 16777215, "to": 16751001 }
]
```

Threshold: ignore deltas below 1px / 0.01 scale / 1° rotation unless user opts strict.

### 6. Report findings (human reviews)

**Required report structure — always use this exact format:**

#### Part A — Coordinate derivations (show the chain)

For each non-trivial container in the hierarchy, show how its world origin is computed:
```
**[ContainerName] origin in world:**
[containerName] at (x, y) pivot=(px, py) → origin at world (wx, wy)
```

#### Part B — Per-node diff table

For each changed prop, one row. Group related props under the same node:

```
| # | Node path | Prop | Current | Proposed |
|---|-----------|------|---------|----------|
| 1 | `container/nodeName` | `propName` | currentValue | **newValue** |
```

Under each node group, show the derivation formula inline (before or after the table rows for that node):
```
**Текущее:** node.y=50 → pivot world y = 490+50=540 → card visual top = 540−59.7 = **480.3**
**Figma:** card top = **340**. Разница = 140.3px вниз.
Исправление:
  card visual top = 340
  pivot world y   = 340 + 59.7 = 399.7
  node.y          = 399.7 − 490 = −90.3 ≈ −90
```

#### Part C — No-change confirmations

List props that were checked and found correct. Keeps trust high.

#### Part D — Flags / assumptions

One bullet per ⚠️. State what was assumed and how to verify.

#### Part E — Apply prompt

End report with: `Применяем?` (or equivalent). Never auto-apply.

---

**Do NOT write patch files or call apply-patch.mjs.** Human reviews report, corrects values if needed, then explicitly triggers application.

### 7. Apply patch (only on explicit user command)

Only when user says "apply" / "да" / confirms explicitly:

1. Write patch JSON to `/tmp/patch-<name>.json`
2. Run dry first, show output, wait for confirmation:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/apply-patch.mjs <scene-path> /tmp/patch-<name>.json --dry
```
3. Apply for real only after dry run reviewed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/apply-patch.mjs <scene-path> /tmp/patch-<name>.json
```
Minimal edit: only touches listed prop keys, preserves key order, preserves tabs/spaces. No reorder, no reformat. Editor diff stays small.

### 8. Verify

Reload editor (user manual) or run game in `mcp__Claude_Preview__preview_start` → screenshot → compare to Figma image. Iterate.

## Engine model — read first

**Before any non-trivial diff** read `references/engine-coordinates.md`. It explains:

- the `resize-attrib` system (`canOverridePivotAndAnchor` master flag, `norm*` props, `useWorld`, `findNearestParent`, `useTextCoordinate`, `stretchAnchor`, `fit`)
- per-class pivot semantics (Sprite vs SizedContainer vs Text vs DSprite vs NineSlicePlane)
- the **Sprite scale·normPivot trap** (`scale=0.5, normPivotX=1` → position is at visual center, not right edge)
- when saved `x/y/pivot` are honored vs overwritten at runtime
- how to detect editor runaway artifacts (`width: 222533` etc.)

The single most-missed gotcha: **`canOverridePivotAndAnchor=false` (default) means the engine ignores every `norm*` prop**. Patches must touch `x/y/pivot` directly. With `canOverridePivotAndAnchor=true`, patching `x/y/pivot` is useless — engine overwrites them on every recalc. **Check this flag first** on every node you patch.

## Coord rules — quick

- Figma origin = top-left frame. Translate every node to scene-local by subtracting parent chain.
- `DSprite` / `MovieClip` anchor default 0.5 → `scene.x = figma.x + figma.width/2`.
- Plain `Sprite` anchor 0,0 → `scene.x = figma.x`.
- `Text` uses BOTH `anchor` (from `style.align`/`verticalAlign`) and `pivot` (from `normPivotX/Y × size`). Read BOTH before computing position.
  - `style.align='center'` + `normPivotX=0` → `anchor.x=0.5`, `pivot.x=0` → scene.x = **text center** = `figma_left + figma_width/2`
  - `style.align='left'` + `normPivotX=0` → `anchor.x=0`, `pivot.x=0` → scene.x = **text left** = `figma_left`
  - `verticalAlign='top'` + `normPivotY=0` → `anchor.y=0`, `pivot.y=0` → scene.y = **text top** = `figma_top` ✓ reliable
  - `verticalAlign='center'` + `normPivotY=0` → `anchor.y=0.5`, `pivot.y=0` → scene.y = text **center** y ⚠️ PixiJS height ≠ Figma height
  - Defaults: `style.align='center'`, `verticalAlign='center'`, `normPivotX=0.5`, `normPivotY=0.5`
  - See `references/coord-mapping.md` → Text section for full formula.
- Scale: `scale.x = figma.width / textureBaseWidth`. Need texture metadata.
- Rotation: Figma deg → PixiJS rad. `rad = deg * Math.PI / 180`. Sign may flip — verify.
- Tint: Figma `{r,g,b}` 0-1 → `Math.round(r*255)<<16 | g*255<<8 | b*255`.

Full table in `references/coord-mapping.md`.

## Non-negotiable rules

1. **Never reorder JSON keys.** Editor sorts canonically; preserving order keeps git diffs small.
2. **Never strip unknown props.** Only touch keys explicitly in patch.
3. **Always ask before patching.** Show table, wait for "yes".
4. **Skip `init`-time-derived props.** `_*` prefix or props the component computes itself shouldn't be patched.
5. **Texture base size lookup required for scale.** Don't guess. Read PNG header or `assets-preloader/main/delayed.json`.
6. **Default anchor differs by class.** Always check class hierarchy (DSprite=0.5, Sprite=0). See thing-editor skill.
7. **Never patch `scale.x` / `scale.y` on Text/BitmapText/HTMLText OR on any ancestor container of a Text node.** Pixi transforms multiply down the tree — parent scale ≠ 1 → child Text rasterized canvas resampled → blur/pixelation, even if Text's own scale is 1. Before patching scale on ANY node, walk descendants. If a Text-class found, refuse the scale patch. Adjust `style.fontSize` on each text leaf instead, and adjust child sprite positions individually to keep layout. Same rule for any subclass of Text.
8. **Check `canOverridePivotAndAnchor` first on every node.** Default is `false` → engine ignores `norm*` props, only saved `x/y/pivot/width` matter. `true` → engine overwrites `x/y/pivot` from `norm*` on every recalc, so patching them is useless. Pick which props to patch based on this flag. See `references/engine-coordinates.md` §3.1.
9. **Analysis-first, never auto-patch.** After computing diff: derive each proposed value with explicit formula trace (show the math and intermediate values), flag every assumption whose engine default is unverified (⚠️), flag every node where the mapping logic is uncertain. Output as a structured findings report. Do NOT write patch JSON files or call apply-patch.mjs automatically — not even with --dry. Wait for user to review the report, correct values if needed, and explicitly approve application.

## Failure modes

- **Names don't match** → fall back to Code Connect mapping file or visual screenshot diff.
- **Figma frame nested in autolayout** → autolayout positions are computed; flatten via `absoluteBoundingBox`.
- **Mask/clip layers in Figma** → no scene equivalent. Skip.
- **Vector shapes in Figma** → if scene has `Shape` component, port radius/color. Otherwise needs sprite export — out of scope.
- **Group vs Frame** → Figma Groups have no own bbox transform; iterate children directly.
- **Text auto-resize** → Figma text bbox includes font metrics; Thing-Editor `Text` uses anchor + style. Compare `characters` to `text` prop, not bbox.

## Reference files

- `scripts/scene-walker.mjs` — parse scene JSON to flat map
- `scripts/apply-patch.mjs` — minimal JSON patcher (preserves formatting)
- `scripts/fetch-figma.mjs` — REST-based Figma fetcher (no MCP, needs `FIGMA_TOKEN`)
- `references/coord-mapping.md` — full coord/color/rotation conversion table
- `references/engine-coordinates.md` — deep engine reference: resize-attrib lifecycle, per-class pivot semantics, lifecycle, common artifacts

## Framelink note

Framelink output schema differs from raw REST: it pre-flattens layout, normalizes fills, and strips noise. Field names: `id`, `name`, `type`, `boundingBox` (x/y/w/h), `fills`, `strokes`, `effects`, `characters`, `style`, `children`. Map these to the per-node fields listed in §2. If a field is absent in Framelink response, fall back to REST script for that node.
