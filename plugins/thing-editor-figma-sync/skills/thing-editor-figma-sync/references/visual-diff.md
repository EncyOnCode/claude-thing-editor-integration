# Visual Diff Workflow (Workflow D) — Future Work

**Status: deferred.** Hooks exist; pixel comparison is not implemented yet.

## Intended interface

```
node diff-snapshot.mjs \
  --figma <snapshot.json> \
  --scene <scene.json> \
  --screenshot <path-to-png>          # screenshot of running game at same logical size
  [--screenshot-source preview]       # future: mcp__Claude_Preview__preview_start integration
```

When `--screenshot` is provided:

1. **Current behavior:** validate file path exists, emit a `flags` entry in the JSON report with code `VISUAL_DIFF_DEFERRED`, continue with the normal coordinate-based diff. Print:
   ```
   Visual diff is a future-work feature. Screenshot hook acknowledged. Skipping pixel comparison.
   ```

2. **Future behavior:**
   - Fetch Figma frame as PNG via `mcp__figma-framelink__download_figma_images` at the scene's logical resolution.
   - Align both PNGs (account for stage rotation in portrait builds, render resolution).
   - Compute pixel-delta and SSIM-style similarity.
   - Emit visual-diff PNG (red overlay where mismatch).
   - Report regions where coordinates match but pixels differ → indicates asset version mismatch or font rendering drift.

## Companion stub: `compare-screenshots.mjs`

```
node compare-screenshots.mjs \
  --a <path-a.png> \
  --b <path-b.png> \
  [--output-diff <path-diff.png>] \
  [--align-hints <json>]
```

Currently prints: `not implemented; see references/visual-diff.md`. Exit code 1.

## Open questions

1. **Alignment offset detection.** Screenshots and Figma exports may have margin differences (canvas padding, stage rotation). Need either explicit user input or automatic feature-point alignment (SIFT-style).
2. **Font rendering differences.** Pixi text uses platform font rendering (different on macOS/Windows/Linux), Figma uses its own renderer. Expect 1-2px deviation per glyph that's NOT a real bug.
3. **HiDPI handling.** Screenshots at 1x vs 2x must be normalized before pixel comparison.
4. **Render resolution mismatch.** Thing-Editor `renderResolution` / `renderResolutionMobile` may differ from Figma export resolution.

## Why deferred

- Pixel diff is a separate concern from coordinate diff (which is already comprehensive in Workflow A).
- Implementing it well requires platform-aware font rendering tolerance + alignment heuristics.
- Coordinate-based diff catches the same bugs (offsets, wrong sizes, wrong colors) without false positives from font rendering.

## When to implement

Priority signal: user reports a case where coordinate diff says "fine" but visual still looks wrong. Then build this workflow tied to a specific failure mode (likely font rendering or asset version drift).

## Recommended approach (when implementation starts)

1. Use `pixelmatch` (Node library) for diff computation.
2. Compute regions of interest from the coordinate-diff matches (only check matched-node bounding boxes).
3. Allow per-class tolerance:
   - Text nodes: high tolerance (font rendering drift)
   - Image fills: low tolerance (asset version mismatch is bug-worthy)
   - Vector shapes: medium tolerance (antialiasing differences)
4. Emit visual report alongside coordinate report; cross-reference matched scenePath ↔ Figma node ↔ visual region.

## Cross-links

- Coordinate-based diff: `coord-mapping.md`, `patch-schema.md`
- Figma image export: `mcp__figma-framelink__download_figma_images` tool schema
- Running game screenshot: `mcp__Claude_Preview__preview_start` (future integration)
