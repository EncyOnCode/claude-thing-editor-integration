---
name: thing-editor-figma-sync
description: Sync Thing-Editor scene/prefab JSON with Figma. 4 workflows — compare existing scene to Figma frame and patch differences, validate Figma layer naming against [Class] name convention, scaffold new .s.json/.p.json skeleton from a Figma frame, future visual screenshot diff. Use when user asks to align game UI to Figma design, fix offsets, missing pixels, color mismatches, import a Figma frame as a scene/prefab, check whether a Figma file follows the naming convention, or paste a Figma URL + scene path. Soft-enforced naming; flag-driven apply policy.
---

# Thing-Editor ↔ Figma Sync (v2)

Bidirectional bridge between Figma and Thing-Editor JSON. Four workflows; pick by user intent.

**Prerequisite skills:**
- `thing-editor` — scene JSON format and gotchas (load if engine details needed)
- `thing-editor-deep` — full engine internals (per-class @editable, gotchas, build pipeline) — load when patches need engine-internal reasoning

## 1. Workflow router — pick by user intent

| User says | Workflow | Goto |
|-----------|----------|------|
| "align scene to Figma" / "fix offsets" / "patch from Figma" | **A** | §3 |
| "check my Figma naming" / "validate Figma layers" | **B** | §4 |
| "scaffold scene from Figma" / "import Figma as prefab" | **C** | §5 |
| "visual diff" / "compare screenshots" | **D** (future) | §6 |

## 2. Prerequisites

### Figma access — pick one (cost order: free → paid)

1. **Framelink `figma-context-mcp`** (free, recommended)
   - Repo: https://github.com/glips/figma-context-mcp
   - Install: `npx -y figma-developer-mcp --figma-api-key=$FIGMA_TOKEN --stdio`
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
   - Tools: `get_figma_data({ fileKey, nodeId, depth? })`, `download_figma_images`.

2. **REST script** `scripts/fetch-figma.mjs` — local, no MCP. Needs `FIGMA_TOKEN`. Use for batch/CI.

3. **Paid `mcp__plugin_figma_figma__*`** — last resort; costs money.

### Project structure

Each project needs:
- `thing-project.json` (project root marker)
- `assets/main.s.json` or other `.s.json` scenes
- `assets/prefabs/*.p.json` for prefab targets of `[Prefab]` tags
- Optional `figma.connect.json` next to `thing-project.json` for component mappings (auto-migrated v1 → v2 on read)

### Figma layer naming convention

`[Class] name (meta)` — square bracket prefix. Soft-enforced: missing tag → auto-infer + warn, never block.

Full spec: `references/naming-conventions.md`. Quick reminder:

```
[Container] hud                                        # frame grouping
[Sprite] cardBack                                      # anchor 0,0
[DSprite] avatar                                       # anchor 0.5,0.5
[Text] scoreLabel                                      # reads characters
[ShapeButton] playBtn                                  # shape + click
[NineSlicePlane] panel (insets:16,16,16,16)            # scalable bg
[Shape] divider (shape:rect, color:0x444444)           # vector
[Prefab] cardItem (variant:joker)                      # .p.json reference
[ref] gameController                                   # existing scene-level child
[Resizer] hud (normAnchor:0.5,1, normPivot:0.5,1)      # responsive
_designNote                                            # design-only, skipped
```

## 3. Workflow A — Compare + Patch existing scene

### 3.1 Fetch Figma snapshot

Via Framelink MCP: call `mcp__figma-framelink__get_figma_data(fileKey, nodeId)` → save response to `/tmp/figma-snapshot.json`.

Via REST: `node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/fetch-figma.mjs --url '<figma-url>' > /tmp/figma-snapshot.json`.

URL format: `figma.com/design/<fileKey>/<name>?node-id=<X-Y>`. Convert `node-id` `-` to `:` for the API.

### 3.2 Run diff

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/diff-snapshot.mjs \
  --figma /tmp/figma-snapshot.json \
  --scene assets/main.s.json \
  [--connect figma.connect.json] \
  [--threshold-px 1] [--threshold-scale 0.01] [--threshold-rot 1] \
  [--strict] \
  [--report-json /tmp/diff-report.json] \
  [--patch-out /tmp/patches.json] \
  [--auto-apply]
```

The script walks both inputs, matches by namePath (composite) + connect-map, computes diffs, emits markdown report + optional JSON sidecar. **Default mode is interactive — report only.** Add `--auto-apply` to chain into `apply-patch.mjs` automatically (dry → real).

### 3.3 Match strategy (script does this; documenting for transparency)

1. **Composite namePath** — Figma layer identifier matched against scene-walker namePath fragments
2. **Connect-map** — `figma.connect.json` mapping by `figmaNodeId` or `figmaComponentSetId`
3. **Unmatched** — surfaced in report's "figmaOnly" / "sceneOnly" sections

Skip Figma layers prefixed `_` (design-only annotations).

### 3.4 Diff report (Parts A–E)

Required structure, always emitted by `diff-snapshot.mjs`:

**Part A — Coordinate derivations** — for each non-trivial container, show how world origin is computed:
```
**[ContainerName] origin in world:**
[containerName] at (x, y) pivot=(px, py) → origin at world (wx, wy)
```

**Part B — Per-node diff table:**
```
| # | Node path | Prop | Current | Proposed | Severity |
|---|-----------|------|---------|----------|----------|
| 1 | `:.0.:.2` | `x`  | 100     | **120**  | patch    |
```

Under each node group, derivation formula:
```
Текущее: node.y=50 → pivot world y = 490+50=540 → card visual top = 540−59.7 = **480.3**
Figma: card top = **340**. Разница = 140.3px вниз.
Исправление: card visual top = 340 → pivot world y = 340 + 59.7 = 399.7 → node.y = 399.7 − 490 = **−90.3 ≈ −90**
```

**Part C — Confirmed (no change needed)** — props checked + correct.

**Part D — Flags & assumptions** — one bullet per ⚠️. Pre-diff probes (canOverridePivotAndAnchor, useWorld, prefabRef, text Y center) listed here.

**Part E — Apply prompt** — `Применяем?` Never auto-apply without `--auto-apply` flag.

### 3.5 Apply

User confirms → run apply-patch:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/apply-patch.mjs \
  assets/main.s.json /tmp/patches.json --dry        # preview
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/apply-patch.mjs \
  assets/main.s.json /tmp/patches.json              # real
```

`apply-patch.mjs` supports `op: 'delete'` entries and class-change refusal via `--allow-class-change`.

## 4. Workflow B — Naming Validator

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/naming-validator.mjs \
  --figma /tmp/figma-snapshot.json \
  [--scene assets/main.s.json] \
  [--project /path/to/project] \
  [--json /tmp/validator-report.json]
```

Optional `--scene` enables `N006` duplicate detection and `R001` ref check. Optional `--project` enables `P001` (prefab existence) and `T002` (font existence) checks.

Soft-enforced: exit 0 (info only), 1 (warn), 2 (error). NEVER blocks compare/generator workflows.

Full rule catalogue: `references/validator-rules.md`.

Typical run on a fresh Figma:
```
[error] M001   [NineSlicePlane] panel — missing required meta (insets:l,t,r,b)
[error] N006   players/avatar         — duplicate within parent
[warn]  N001   cardBack               — no [Class] tag, inferred Sprite
[info]  P003   [Prefab] avatar        — matched via componentId
Summary: 2 error, 1 warn, 1 info  (exit 2)
```

## 5. Workflow C — Generate Scene/Prefab Skeleton

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/thing-editor-figma-sync/scripts/generate-skeleton.mjs \
  --figma /tmp/figma-snapshot.json \
  --out assets/new-screen.s.json \
  [--prefab] \
  [--project /path/to/project] \
  [--connect figma.connect.json] \
  [--root-class Main|Scene|Container] \
  [--orientation portrait|landscape] \
  [--dry]
```

Produces:
- `<out>.s.json` (or `.p.json` with `--prefab`) — the scene skeleton
- `<out>.TODO.md` — sidecar with High/Medium/Low priority manual work items

### What gets emitted

- Container hierarchy mirrors Figma frame tree
- Per-class geometry computed from `absoluteBoundingBox` with anchor conversion
- `[Prefab] name` → `{"r":"name", "p":{...placement}}` reference, children NOT expanded
- `[ref] name` → NO node emitted, just TODO sidecar entry
- Inline `___TODO` markers (TRIPLE underscore — stripped on first editor save via `fs.fieldsFilter`)
- Auto-inferred classes (Sprite, Container, etc.) logged in sidecar with confidence

### What the generator CANNOT do (always TODO)

- Data-paths (`"this.#child"`, `"all.cardFactory"`)
- Callbacks (onClick handlers, MovieClip onComplete)
- DI tokens (tsyringe @inject)
- MovieClip timelines, Spine skeletons, ParticleSystem emitter configs
- `translatableText` keys (L10n table is project data)
- Custom controller classes (BalanceViewController etc. → emitted as Text + TODO)

### Review order

**ALWAYS review `.TODO.md` BEFORE opening the generated `.json` in editor** — inline `___TODO` markers disappear on first save.

Full decision tree: `references/generator-rules.md`.

## 6. Workflow D — Visual Diff (deferred)

`diff-snapshot.mjs --screenshot <path.png>` accepts the flag, prints "future-work feature, skipping pixel comparison", continues with coordinate diff.

`scripts/compare-screenshots.mjs` is a stub.

Future-work spec: `references/visual-diff.md`. Intended interface: align Figma PNG export + Thing-Editor screenshot, pixel-delta + SSIM, region-of-interest from matched-node bboxes.

Coordinate-based diff (Workflow A) already catches most visual bugs (offsets, sizes, colors, fonts). Visual diff is for font-rendering drift and asset version mismatch — rare cases.

## 7. Engine model — links only

Don't duplicate engine knowledge here. Cross-references:

- **Coord rules per class:** `references/coord-mapping.md` (full anchor/pivot table, text dual-anchor model, pivot trap)
- **Resize-attrib lifecycle, per-class width semantics:** `references/engine-coordinates.md`
- **Patch JSON schema + `figma.connect.json` v2:** `references/patch-schema.md`
- **Per-class `@editable` fields, defaults, gotchas:** companion plugin `thing-editor-deep/references/03-components.md`
- **DSprite anchor 0.5, ScrollLayer single-drag, etc.:** `thing-editor-deep/references/10-gotchas.md`
- **MovieClip timeline JSON, FieldPlayer easing:** `thing-editor-deep/references/05-animation.md`

The single most-missed gotcha: **`canOverridePivotAndAnchor=false` (default) means the engine ignores every `norm*` prop**. Patches must touch `x/y/pivot` directly. With `canOverridePivotAndAnchor=true`, the engine overwrites `x/y/pivot` from `norm*` on every recalc, so patching them is useless. The `diff-snapshot.mjs` script flags this automatically via the pre-diff probe.

## 8. Non-negotiable rules

1. **Never reorder JSON keys.** Editor sorts canonically; preserving order keeps git diffs small.
2. **Never strip unknown props.** Only touch keys explicitly in patch.
3. **Always ask before patching.** Show table, wait for "yes". Default mode is interactive; `--auto-apply` is opt-in.
4. **Skip `init`-time-derived props.** `_*` prefix or props the component computes itself shouldn't be patched.
5. **Texture base size lookup required for scale.** Don't guess. Use `texture-base.mjs` (atlas / spritesheet / PNG header).
6. **Default anchor differs by class.** Always check class hierarchy (DSprite=0.5, Sprite=0). See `class-tokens.mjs`.
7. **Never patch `scale.x` / `scale.y` on Text/BitmapText/HTMLText OR any ancestor.** Pixi transforms multiply down — parent scale ≠ 1 → child Text rasterized canvas resampled → blur. `apply-patch.mjs` refuses these unless `--force`. Adjust `style.fontSize` on each text leaf instead.
8. **Check `canOverridePivotAndAnchor` first on every node.** `diff-snapshot.mjs` emits a flag automatically. With `true`, patch `norm*` instead of `x/y/pivot`.
9. **Analysis-first, never auto-patch.** Derive each proposed value with explicit formula trace. Flag every assumption with ⚠️. Output structured findings report. Do NOT write patch JSON OR call apply-patch.mjs automatically — wait for user approval. `--auto-apply` is opt-in user gesture.
10. **Soft naming enforcement.** Validator output never blocks compare/generator. Even with errors, those workflows proceed using auto-infer fallbacks. Surface issues; let user fix on their schedule.
11. **Generated skeletons are never authoritative.** Always present `.TODO.md` to user; never claim "done" after a generator run. The skeleton is a starting point, not a finished scene.

## 9. Failure modes

- **Names don't match** → fall back to Code Connect mapping file or composite namePath matching. Walker emits warnings; surface them.
- **Figma frame nested in autolayout** → autolayout positions are computed; flatten via `absoluteBoundingBox`. No special handling needed.
- **Mask/clip layers in Figma** → maps to `Mask` component if tagged `[Mask]`; otherwise warn S003 info.
- **Vector shapes in Figma (BOOLEAN_OPERATION, VECTOR, STAR, LINE)** → unsupported; generator emits Sprite-stub TODO. Designer must flatten or export as PNG.
- **Group vs Frame** → Figma Groups have no own bbox transform; walker iterates children directly.
- **Text auto-resize** → Figma text bbox includes font metrics; Thing-Editor Text uses anchor + style. Compare `characters` to `text` prop, not bbox dimensions.
- **Framelink token references** (`layout_XYZ`, `style_ABC`) → fall back to REST fetcher which resolves them.
- **Drop-shadow / blur effects** → `DropShadowFilter` mapping in generator-rules.md; partial support.

## 10. Reference files

- `scripts/scene-walker.mjs` — parse scene JSON to flat map (extended in v2 with hasResizer, canOverridePivotAndAnchor, resizeAttribFlags)
- `scripts/apply-patch.mjs` — minimal JSON patcher (preserves formatting, supports `op:'delete'`, `--allow-class-change`)
- `scripts/fetch-figma.mjs` — REST-based Figma fetcher (no MCP, needs `FIGMA_TOKEN`)
- `scripts/figma-walker.mjs` — classify Figma snapshot, parse `[Class] name (meta)` tags
- `scripts/diff-snapshot.mjs` — Workflow A entry (compare + report + optional patch + optional auto-apply)
- `scripts/naming-validator.mjs` — Workflow B entry
- `scripts/generate-skeleton.mjs` — Workflow C entry
- `scripts/compare-screenshots.mjs` — Workflow D stub (future work)
- `scripts/shared/class-tokens.mjs` — recognized `[Class]` token registry (single source of truth)
- `scripts/shared/figma-classify.mjs` — `[Class] name (meta)` parser + auto-infer
- `scripts/shared/coord-resolve.mjs` — anchor/pivot math, tint conversion
- `scripts/shared/report-format.mjs` — markdown + JSON emitters
- `scripts/shared/connect-map.mjs` — read/write figma.connect.json with v1 migration
- `scripts/shared/texture-base.mjs` — texture base-size lookup (atlas / spritesheet / PNG header)
- `references/coord-mapping.md` — full coord/color/rotation conversion table
- `references/engine-coordinates.md` — deep engine reference (resize-attrib lifecycle, per-class pivot semantics)
- `references/naming-conventions.md` — `[Class] name` grammar + recognized tokens + auto-infer table
- `references/validator-rules.md` — full rule catalogue with severity
- `references/generator-rules.md` — Figma node → SerializedObject decision tree
- `references/patch-schema.md` — patch JSON + figma.connect.json v2 schema
- `references/visual-diff.md` — Workflow D future-work spec

## 11. Framelink output note

Framelink output differs from raw REST: pre-flattens layout, normalizes fills, uses token references for layout/style (`layout_XYZ`, `style_ABC`). If a field is absent in Framelink response, fall back to REST script for that node. `figma-walker.mjs` accepts both shapes — auto-detects input format.
