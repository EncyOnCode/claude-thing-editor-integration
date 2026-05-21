---
name: figma-sync
description: Drive end-to-end Figma↔Thing-Editor sync for a project. Iterates each scene in figma.sync.json, opens it in the running editor via the command channel, fetches the matched Figma frame, runs diff, classifies patches (auto-safe / review / dynamic-state), applies safe ones, masks dynamic regions from SSIM, reports verdict. Requires the editor open on the project and the engine command channel built into thing-editor (feat-ai-integration branch).
---

# /figma-sync — AI-gated Figma sync

Usage:
- `/figma-sync <project-path>` — process all scenes in figma.sync.json
- `/figma-sync <project-path> <scene-name>` — process one scene
- `/figma-sync <project-path> <scene-name> review` — run diff + SSIM but do not apply patches (review-only)

## Preconditions

1. Editor running on the project (engine command channel watches
   `<project>/.thing-editor-meta/.command.json`).
2. `FIGMA_TOKEN` env var available to subprocess calls.
3. `<project>/figma.sync.json` exists — generate via
   `node scaffold-figma-sync.mjs --project <path> --map scene=<figma-url>,…`.

## Workflow

For each scene listed in `figma.sync.json`:

### Phase 1 — initial export + diff
- Run `figma-sync.mjs --project <path> --scene <name> --threshold 0.95`
  *without* `--apply`. This opens the scene via the command channel,
  exports snapshot + screenshot, fetches the Figma JSON and PNG, runs
  walker + diff, and persists `/tmp/diff-report-<name>.json` plus
  `/tmp/ssim-report-<name>.json` (the report contains per-region SSIM
  including world.bounds for every visible scene entry).

### Phase 2 — classify patches and regions
Read `/tmp/diff-report-<name>.json`. For each entry in `diffs[]`,
group into three buckets:

- **auto-safe**: severity `patch`, the corresponding `matches[]` entry
  has `confidence` in `{high, namePath, connectMap}`, and the prop is
  one of `x`, `y`, `normalizePosX`, `normalizePosY`, `tint`, `alpha`,
  `rotation` (coord/visual chrome). Apply these.
- **review**: severity `patch` but the match confidence is
  `medium/low/pathSuffix/fuzzyLeaf/bbox` OR the prop is `text` /
  `style.fontSize`. Surface to the user inline; do not auto-apply.
- **state-drift**: skip entirely — these are runtime data regions.
  Detect by matching the scene-flat entry's `namePath` against these
  patterns (case-insensitive, substring):
  - `balance`, `score`, `points`, `wallet`, `coin`
  - `name`, `nick`, `username`, `player`, `guest`, `opponent`, `avatar`
  - `time`, `timer`, `countdown`
  - `result`, `winner`, `loser`
  Build a regex like
  `/(balance|score|points|wallet|coin|name|nick|username|player|guest|opponent|avatar|time|timer|countdown|result|winner|loser)/i`
  Persist this as the `--exclude-pattern` value for phase 4.

### Phase 3 — apply auto-safe
Write the auto-safe subset to `/tmp/patches-auto-<name>.json` then run:
```bash
node apply-patch.mjs <scene.s.json> /tmp/patches-auto-<name>.json \
  --project <project>
```
If `apply-patch` refuses any entries (text scale, layout-managed), move
them to the `review` bucket and continue.

### Phase 4 — re-export + SSIM with dynamic-region mask
After patches land, the user must reload the scene in the editor (the
editor doesn't poll JSON files between commands). Then issue another
`figma-sync.mjs` pass with `--exclude-pattern` set to the regex from
phase 2:
```bash
node figma-sync.mjs --project <path> --scene <name> \
  --exclude-pattern '(balance|score|name|avatar|...)' \
  --threshold 0.85
```
Verdict comes from SSIM with dynamic regions masked black: if the
masked SSIM passes the threshold, the static UI chrome aligns; the
dynamic regions are documented as state-drift, not bugs.

### Phase 5 — final report
Produce a per-scene table:
- pass / drift / error
- pre-SSIM, post-SSIM, threshold
- applied patches count
- review-queue length
- state-drift regions identified

For each `review` patch, prompt the user `apply: [y/N/edit]` inline.
Apply on `y`, skip on `N`, allow `edit` to tweak the patch value.

## Critical scripts

- `plugins/thing-editor-figma-sync/skills/thing-editor-figma-sync/scripts/figma-sync.mjs` — the orchestrator. CLI flags: `--project`, `--scene`, `--apply`, `--threshold`, `--exclude-pattern`, `--exclude-class`, `--auto-confidence high|medium|low`.
- `plugins/.../scripts/scaffold-figma-sync.mjs` — first-run config generator. CLI flags: `--project`, `--file-key`, `--map scene=<url>,…`, `--merge`.
- `plugins/.../scripts/compare-screenshots.mjs` — SSIM comparator with `--exclude-pattern`/`--exclude-class` masking and per-region `excluded` markers.

## Failure handling

- **Command channel timeout (~30s)** — editor not open on the project, or
  the running editor lacks the engine command-channel commit
  (thing-editor#32a4c617). Tell the user explicitly which project the
  editor must be open on.
- **Figma 403 on variables endpoint** — token lacks `file_variables:read`
  scope. DS hints become unavailable; the rest of the workflow still
  runs.
- **Figma 429** — pace requests. The orchestrator already retries with
  backoff; if exhausted, report to user and resume after the
  `Retry-After` window.
- **No matches** — scaffold `figma.connect.json` via
  `scaffold-connect.mjs` so the user can hand-author the mapping for
  layers whose names don't follow the convention.
