---
name: thing-editor-design-review
description: Automated design-review for Thing-Editor games against Figma — orchestrates the `design-review` CLI. Use when the user wants to compare a game scene to its Figma frame, find/fix design drift (offsets, sizes, colours, fonts, missing nodes), run `design-review` / `automap` / `fix` / `check` / `scaffold-state`, set up `<scene>.review.json` or `figma.connect.json`, implement an `__enterReviewState` review hook, or read a design-review triage report. Drives a headless Thing-Editor, diffs scene-vs-Figma, auto-patches the safe subset, triages the rest, emits a before/after compare page.
---

# Thing-Editor ↔ Figma Design Review

Orchestrates the **`design-review` CLI** (`tools/design-review` in the thing-editor repo)
to compare a game scene against its Figma frame and auto-fix what is safely patchable.

The CLI is the engine — diff, classify, patch, triage. This skill is the playbook: the
command sequence, the prerequisites, the hard-won gotchas, and how to read the triage.
**This skill adds no logic — it drives the CLI.**

**Prerequisite skills:**
- `thing-editor-deep` — engine internals; load when writing an `__enterReviewState` hook or reasoning about a patch (coord/layout/resize model, gotchas).
- `thing-editor-figma-sync` — Figma `[Class] name` naming convention, coordinate math; complements this skill.

## 1. What the pipeline does

```
 snapshot   drive headless editor → export scene snapshot (v2, world.ownBox per node)
 fetch      pull the Figma frame for the state via REST
 diff       class-agnostic tree-vs-tree diff (scale-corrected, ownBox, path-matched)
 classify   bucket every mismatch
 fix        auto-patch the safe subset; apply-patch refuse-guards re-bucket the rest
 triage     5-bucket report + before/after compare.html
```

It catches **authored design drift** — position, size, colour, font, missing/extra nodes.
It does NOT catch animation, gameplay logic, or anything runtime-driven unless modelled as
a named review state.

## 2. Prerequisites — check before running

1. **`FIGMA_TOKEN`** env var — a Figma personal-access token with read access to the
   project's Figma file. A wrong/inaccessible file key → `404`. The file key comes from
   `thing-project.json → figma.fileKey`, `figma.connect.json → figmaFileKey`, or
   `<scene>.review.json → figmaFileKey`.
2. **Vite dev server** running (`cd <editor-repo> && npx vite`, port 5173) — the CLI does
   not start it. **Reuse the developer's Vite if it is already up.** If you must start it
   yourself it now occupies the developer's :5173 — see §5 gotcha 8: hand it back, never
   just leave it.
3. **The editor** — see §5 gotcha: if a GUI editor is already open on the project, the
   pipeline must *drive that instance*, not spawn a second one.
4. **CLI built** — `cd tools/design-review && npm run build` (it is a TypeScript package;
   run from `node dist/cli.js …` or the `design-review` bin).

## 3. Pipeline — the ordered workflow

### Step 0 — setup (once per scene)
- `<scene>.review.json` under `assets/` — declares review `states` (each `stateId →
  figmaNodeId + scope`), `ignore`, `tolerance`. Scaffold with `design-review init <scene>`,
  then fill `figmaNodeId` per state.
- `figma.connect.json` at the project root — the `dataPath → figmaNodeId` mapping. Drafted
  by `automap` (Step 1); do not hand-author 17 entries.

### Step 1 — automap
`design-review automap <scene>` — drives the editor, snapshots, aligns the Figma tree to
the scene tree, writes a draft `figma.connect.json` + a `<scene>.automap.md` sidecar.
**Read the sidecar**: 🟢 high rows are pre-accepted; 🟡🟠 medium/low and 🔴 unmatched need
a human check — present them to the user, confirm or correct. Auto-mapping only works when
the Figma layers are named for the engine; a default-named Figma file (`Frame 787…`, `BG`)
yields mostly unmatched — then mappings are confirmed by hand into `figma.connect.json`.

### Step 2 — driven review states
The `default` state is the scene as loaded. Any other state needs the scene class to
implement `__enterReviewState(stateId)`. `design-review scaffold-state <scene>` prints the
stub. **Filling the hook is the biggest single lever** — an un-driven snapshot leaves ~half
the diff as `needs-state` noise (prefab defaults, hidden elements). When writing the hook,
load `thing-editor-deep` and obey §5's un-inited/locals gotcha.

### Step 3 — fix
`design-review fix <scene> --state=<id>` — diff → classify → auto-patch the safe subset →
triage. It also auto-emits `compare.html` + `figma.png` + `engine.png` under
`.thing-editor-meta/design-review/<scene>-<state>/`. Use `design-review check` instead for
a read-only diff with no patching.

### Step 4 — read the triage buckets

| Bucket | Meaning | Action |
|--------|---------|--------|
| ✅ **auto-fixed** | safe scalar patched in the scene `.s.json` | verify on re-run |
| 🔧 **patch-parent** | child is layout/recalc-managed — apply-patch refused | resolve by hand — §3b "layout-managed child positions" |
| 🖼 **asset-todo** | size lives in the texture/atlas, not JSON | re-export the PNG at design size — §3b "oversized-texture Sprite" |
| 🎬 **needs-state** | runtime-driven, not authored | implement/extend `__enterReviewState`, or `ignore` if genuinely dynamic |
| ⚠️ **false-positive** | tool/model artifact (anchor model, Figma `textCase`) | add to `review.json` `ignore` |
| ✋ **manual** | unbuildable / prefab-internal | prefab-internal → §3b; else review by hand |

### Step 5 — verify
Reload the editor (§5), re-run `design-review check <scene> --state=<id>`. Auto-fixed
entries must now match. Open `compare.html` — overlay + difference blend.

## 3b. The hard buckets — what `fix` automates, what stays manual

`fix` now auto-resolves more than the safe scalar subset. It also: routes **prefab-internal**
patches into the right `.p.json` (when an inner element drifts *consistently* across all
instances of the prefab); rewrites **recalc-position** refusals to `normalizePosX/Y`; and
folds **uniform layout-managed sibling drift** into one parent patch (Phase 5, via
`normalizePos*` when the parent is `canOverridePivotAndAnchor`).

What still needs a human: an inner element that drifts *non-uniformly* across instances
(→ `manual`, "instance-position drift" — the fix is the instances' parent `LayoutGroup`
params, see below); oversized-texture assets; colour (`fill`/`tint`, v1). The methods
below explain the reasoning the tool applies — and how to resolve the genuine residual.

**Layout-managed child positions (patch-parent).** A child of a LayoutGroup/LayoutGrid/
Resizer has its x/y recomputed every layout — patching the child is futile. Decompose the
per-sibling world deltas:
- A constant *difference* between two siblings on one axis = the group's `spacingX/Y` is
  wrong by that amount: `spacingY' = spacingY + (Δsibling2 − Δsibling1)`. Applying it makes
  all siblings drift *equally*.
- The remaining *common* drift = the group itself is mis-placed. Move the group: if it has
  `canOverridePivotAndAnchor`, patch `normalizePosX/Y` (engine: `y = parentH·normAnchorY +
  normalizePosY`), else plain x/y.
- One `spacingY` controls *every* gap in the group. If gap A must differ from gap B (e.g.
  title→panel ≠ panel→panel), no single param solves it → it is a **scene-structure**
  problem (wrap a subset in its own group). Surface it to the user; don't guess.

**Prefab-internal entries** (`skipped`, inside a `.p.json` instance). Compare the *same*
element's delta across **all instances** of that prefab:
- Consistent across instances → patch the element in the `.p.json` directly — one edit
  fixes every instance. (Confirm the prefab has no inner LayoutGroup; if it does, the
  element is layout-managed one level down — apply the method above to the prefab.)
- Inconsistent → it is not the prefab; it is the instance positions (layout-managed).

**Text vs Sprite deltas.** A Text node's x/y delta carries a baseline-metric component
(PIXI raster ≠ Figma bbox) that is irreducible (~9px typical). For the *true* geometric
drift read a sibling **Sprite**'s delta — clean geometry. Fix to the Sprite's number; the
Text residual stays a `warning`, leave it.

**Oversized-texture Sprite (asset).** A Sprite whose texture ≠ design size shows
width/height drift *and* x/y drift (≈ half the size overage, when centered). Do **not**
scale-patch it — PIXI scales from the sprite origin, which adds a position shift. Re-export
the PNG at design size. An oversized sprite that is a LayoutGroup child also corrupts its
siblings' layout — fix the asset first, then solve the siblings.

**Iteration loop.** Edit `.s.json`/`.p.json` → re-run the headless `fix`/`check` (fresh
disk read; GUI editor closed — §5.3) → re-measure → adjust. `.s.json`/`.p.json` edits need
no editor reload; `.c.ts` do. For precise per-node deltas, a read-only `runDiff` script is
fine — but you **must** fold `figma.connect.json` into `meta.mappings` first
(`dataPathMappings`), else node matching falls back to bare-name and yields garbage deltas.

## 4. Command reference

| Command | Purpose |
|---------|---------|
| `list` | discover scenes + declared review states |
| `check <scene> [--state=<id>]` | diff scene vs Figma — read-only, emits report + compare |
| `check-all` | iterate every `*.review.json` scene (CI) — auto-regenerates the index page |
| `init <scene>` | scaffold a starter `<scene>.review.json` |
| `automap <scene>` | draft `figma.connect.json` + `<scene>.automap.md` |
| `fix <scene> [--state=<id>] [--all-states]` | diff → auto-patch safe subset → triage |
| `scaffold-state <scene>` | print the `__getReviewStates`/`__enterReviewState` stub |
| `verify-mapping <scene>` | check every mapping resolves on both sides |
| `report` | regenerate `index.html` from `triage.json` sidecars under `.thing-editor-meta/design-review/` |

Common flags: `--project=<path>`, `--editor=<path>`, `--state=<id>`, `--all-states`,
`--attach`, `--report=<path>`, `--json=<path>`, `--verbose`. Env: `FIGMA_TOKEN`.

### Newer surface (Tier 2–4)

- **`fix --all-states`** iterates every state in `<scene>.review.json` in one driver
  session, accumulating patches across iterations. Rejects `--attach` (live GUI cache).
- **`review.json` `states[id].variants[]`** — per-orientation Figma frames
  (`{ orientation: "portrait" | "landscape", figmaNodeId }`). CLI resolves the snapshot's
  orientation and picks the matching variant, falling back to the top-level `figmaNodeId`.
- **Spacing patches** — Phase-6 instance-drift detector folds linearly-drifting
  LayoutGroup siblings (≥3 instances, R²≥0.95) into one `spacingX/Y` patch on the parent.
  Shows up in the triage as the **`spacing-patched`** bucket.
- **Asset re-export queue** — `fix` writes `assets/<scene>.asset-reexport.json` listing
  textures whose `width`/`height` drifted (with `currentSize` / `targetSize` /
  `figmaNodeId` / `usedBy`). Hand this to the designer or feed an external pipeline.
- **Index page** — `check-all` automatically regenerates `index.html` at
  `.thing-editor-meta/design-review/index.html` (a grid of every compare folder).
  Manual: `design-review report`.

## 5. Critical gotchas — read before every run

1. **Editor reload after game `.c.ts` edits.** Vite HMR does NOT load changed game classes
   into the running editor. After editing a scene/component class (e.g. an
   `__enterReviewState` hook), the user must **reload the editor** (Cmd+R / restart) — else
   the pipeline runs stale code and throws `does not implement __enterReviewState` or
   stale-reference errors. Tell the user to reload; wait.
2. **The editor loads scenes un-inited.** `open-scene` deserializes the tree but does NOT
   run component `init()`. So an `__enterReviewState` hook cannot rely on init-resolved
   fields — it must resolve child refs itself, **into local variables**. Never store a
   cross-object reference in a class field from review code: the editor's reference
   validation rejects it (`errorCode 10041` — "outdated reference, clear in onRemove").
   Resolve with `getValueByPath(this._somePath, this)` into a `const`, use, discard.
3. **One editor only.** If a GUI editor is already open on the project, drive that
   instance over the file command-channel — do NOT spawn a second headless editor; both
   would race on `.thing-editor-meta/.command.json`.
   **`--attach` is one-shot, not for iterating on scene edits.** `fix --attach` drives a
   running editor, but `open-scene` on the *already-open* scene does NOT re-read the
   `.s.json` from disk — the editor keeps it in memory. So after you edit a `.s.json`,
   `--attach` re-measures the STALE scene. For an edit→re-measure loop use the plain
   headless-spawn `fix` (fresh disk read each run), which needs the GUI editor closed.
   **Driving a GUI editor dirties and may SAVE its scene.** `enter-state` runs the
   `__enterReviewState` hook (mutates live objects) and the `LayoutGroup` editor interval
   marks the scene modified — so on close the editor saves review-state values into the
   real `.s.json`/`.p.json` (end-screen becomes visible, loading hidden, recalced coords
   baked). Recover with `git checkout` of the scene/prefab. Prefer headless `fix` (its own
   throwaway process — nothing saved back) when scene files matter; warn the user before
   `--attach`.
   **Stale command file crashes the next editor.** `command-watcher.js` is
   `ignoreInitial:false` — an editor opening a project *replays* whatever is in
   `.thing-editor-meta/.command.json`. A leftover `quit` from a prior run → the editor
   quits itself on startup (presents as a SIGABRT — just fsevents teardown). The CLI's
   `EditorDriver.quit()` clears the channel; if you write `.command.json` by hand, delete
   it after. Editor crashes on open → check for a stale `.command.json` first.
4. **Un-driven snapshot.** Before the `__enterReviewState` hook exists, the snapshot shows
   prefab defaults — ~half the diff is `needs-state` and the `compare.html` overlay ghosts
   badly. Implement the hook first; it is the highest-impact step.
5. **`ignore`, do not fake.** Overscan sprites (a full-screen `blackout`) and
   provider/server-driven values (a balance label) are genuinely not authored geometry —
   put them in `review.json → ignore`, never patch them to match.
6. **Figma naming.** `automap` is only as good as the Figma layer names. A file named for
   the engine (`[Class] name`) auto-maps; a default-named file needs hand-confirmed
   `figma.connect.json` entries.
7. **Text never matches pixel-perfect.** PIXI rasterises text with line-height/ascender
   metrics; Figma's text bbox is the tight glyph box. The diff treats text geometry as
   `warning`, not `error`, for this reason — do not chase pixel-perfect text overlay.
8. **Never block the developer's machine — leave it as you found it.** The pipeline needs
   Vite (:5173) and an editor; these are often the developer's own running processes.
   - **NEVER `kill`/`pkill` a Vite or editor process you did not start.** That drops the
     developer's work mid-task. If the developer's process is in the way, ask them — do
     not terminate it yourself.
   - **Reuse, don't duplicate.** If Vite / the editor is already up, drive it; do not
     spawn a second one (also §5 gotchas 1–3).
   - **Whatever you start, you own.** A Vite you launch occupies :5173 and *blocks the
     developer from starting their own editor*. Track every process you spawn; when your
     run finishes, stop it — or explicitly tell the user it is still running and why, and
     stop it the moment they ask. Do not silently leave background processes behind.

## 6. Non-negotiable rules

1. **Analysis-first.** Present the triage before acting. Explain each bucket.
2. **`fix` writes to the real game scene `.s.json`.** It is git-tracked and reversible, but
   surface exactly what was patched; confirm intent before running `fix` on a scene the
   user has not asked to modify. Use `check` for a dry look.
3. **Never auto-fill `ignore` to hide real drift.** `ignore` is for genuinely dynamic or
   tool-artefact fields only.
4. **The compare page is emitted every `fix`/`check` run** — always point the user at it.
5. **Patch-parent / prefab-internal entries are TODO, not failures** — the tool triaged
   them deliberately; relay the reason and the suggested parent/`.p.json` change.
