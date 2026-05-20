#!/usr/bin/env node
// Workflow D: visual diff via screenshot comparison.
// **STATUS: stub. Not implemented.** See references/visual-diff.md for spec.
//
// Future interface:
//   node compare-screenshots.mjs \
//     --a <path-a.png> \
//     --b <path-b.png> \
//     [--output-diff <path-diff.png>] \
//     [--align-hints <json>]
//
// Returns: { pixelDelta, ssim, regions: [{ x, y, w, h, deltaPercent }] }

console.error('compare-screenshots.mjs: not implemented yet.');
console.error('See references/visual-diff.md for the intended interface and future-work spec.');
console.error('');
console.error('Coordinate-based diff (Workflow A) catches the same bugs in most cases.');
console.error('Trigger this implementation only when font-rendering drift or asset version mismatch is suspected.');
process.exit(1);
