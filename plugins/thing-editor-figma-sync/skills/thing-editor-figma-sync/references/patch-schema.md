# Patch JSON Schema + `figma.connect.json` Schema

## Patch JSON (consumed by `apply-patch.mjs`)

```json
[
  { "scenePath": [":", 0, ":", 2], "prop": "x", "to": 120 },
  { "scenePath": [":", 0], "prop": "scale.x", "to": 1.05 },
  { "scenePath": [":", 1], "prop": "tint", "to": 16751001 },
  { "scenePath": [":", 3], "prop": "pivot.x", "to": 48.3 },
  { "scenePath": [":", 4], "prop": "style.fontSize", "to": 24 },
  { "scenePath": [":", 5], "op": "delete", "prop": "alpha" }
]
```

### Entry shape

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scenePath` | `(string \| number)[]` | yes | JSON pointer array from `scene-walker.mjs` output. Points at the NODE (object with `c/p/:`), NOT into `p`. |
| `prop` | string | yes | Property name. Supports dot notation (`scale.x`, `style.fontSize`, `pivot.x`). |
| `to` | any | when `op:'set'` (default) | New value. |
| `op` | `'set' \| 'delete'` | no, default `'set'` | Patch operation. v1 patches omit this and default to `set`. |

### `scenePath` examples

```
[":", 0]                    → first child of root
[":", 0, ":", 2]            → root.children[0].children[2]
[":", 0, "::", 2]           → same as above (some emitters use ::)
```

The patcher in `apply-patch.mjs` understands both `:` and `::` for legacy reasons.

### Property dot-notation

```
"x"               → node.p.x
"scale.x"         → node.p["scale.x"] (literal key — engine convention)
"style.fontSize"  → node.p["style.fontSize"]
"pivot.x"         → node.p["pivot.x"]
```

Engine serializes dotted keys verbatim — they are NOT nested objects in JSON. Patcher uses bracket access, not dot traversal.

### Safeguards (existing in v1, preserved in v2)

1. **Text scale guard**: if `scenePath` resolves to a Text node OR a node with a Text descendant, patches to `scale.x`/`scale.y` are REFUSED with severity `refuse`. Reason: Text rasterizes at fontSize; scaling resamples → blur. Patch `style.fontSize` instead.
2. **Class change guard** (v2 new): if a patch tries to change `c` or `r`, refused unless `--allow-class-change` flag is set.
3. **Dry-run mode**: `--dry` prints intended writes without modifying files.
4. **Minimal edit**: preserves key order, indentation (tabs vs spaces auto-detected), unmodified props.

### Severity in diff output

When `diff-snapshot.mjs` emits patches, each carries a severity hint:

```json
{
  "scenePath": [":", 0],
  "prop": "scale.x",
  "from": 1.0,
  "to": 1.05,
  "delta": 0.05,
  "severity": "patch",
  "reason": "Figma width / texture base width = 1.05"
}
```

| Severity | Meaning |
|----------|---------|
| `patch` | Apply normally |
| `skip` | Below threshold OR ambiguous (e.g. center/center Y) — don't apply, document |
| `refuse` | Hard blocker (text scale, class change). `--auto-apply` aborts the whole run. |

## Report JSON sidecar (Workflow A output)

Written when `--report-json <path>` provided to `diff-snapshot.mjs`.

```json
{
  "scene": "games/skill-games-durak/assets/main.s.json",
  "figma": {
    "fileKey": "abc123XYZ",
    "nodeId": "1:1"
  },
  "matches": [
    {
      "scenePath": [":", 0, ":", 2],
      "figmaId": "1:23",
      "matchedBy": "namePath",
      "namePath": "main/hud/scoreLabel"
    },
    {
      "scenePath": [":", 0, ":", 5],
      "figmaId": "5:99",
      "matchedBy": "connectMap"
    }
  ],
  "diffs": [
    {
      "scenePath": [":", 0, ":", 2],
      "prop": "x",
      "from": 100,
      "to": 120,
      "delta": 20,
      "severity": "patch",
      "reason": "Figma left - parent origin = 120"
    }
  ],
  "unmatched": {
    "figmaOnly": [
      { "figmaId": "1:99", "name": "newButton", "type": "FRAME" }
    ],
    "sceneOnly": [
      { "scenePath": [":", 0, ":", 7], "name": "oldButton" }
    ]
  },
  "flags": [
    {
      "scenePath": [":", 0, ":", 3],
      "code": "RESIZE_ATTRIB_OVERRIDE",
      "level": "warn",
      "message": "canOverridePivotAndAnchor=true → patching norm* instead of x/y/pivot"
    }
  ],
  "summary": {
    "matched": 142,
    "diffs": 17,
    "patches": 12,
    "skipped": 5,
    "refused": 0,
    "figmaOnly": 1,
    "sceneOnly": 1,
    "flags": 3
  }
}
```

## `figma.connect.json` schema v2

File location: `<project-root>/figma.connect.json` (one per Thing-Editor project; project root identified by `thing-project.json` sibling).

```jsonc
{
  "version": 2,
  "figmaFileKey": "abc123XYZ",
  "mappings": [
    {
      "figmaNodeId": "1:23",
      "figmaComponentSetId": "5:67",

      "scenePath": ["assets/main.s.json", ":", 0, ":", 2],
      "prefabName": "cardItem",

      "classOverride": "ShapeButton",

      "variantMap": {
        "State=default": "cardItem",
        "State=hover":   "cardItemHover"
      },

      "assetMappings": {
        "imageRef-abc123def": "assets/img/cardBack.png",
        "imageRef-def456ghi": "assets/img/cardFace.png"
      },

      "skip": false,
      "notes": "Free-text preserved through writes"
    }
  ]
}
```

### Field semantics

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `version` | yes | int | `2`. v1 entries (bare `{figmaNodeId, scenePath}`) auto-migrated on read. |
| `figmaFileKey` | no | string | Default file key for all entries; per-entry can override. |
| `mappings` | yes | array | Mapping entries. |

### Per-entry fields

Each entry MUST have:
- (`figmaNodeId` OR `figmaComponentSetId`) — what's being mapped
- (`scenePath` OR `prefabName`) — what it maps to

Optional:
- `classOverride` — forces a class even if `[Class]` tag missing/wrong. Useful for legacy Figma files.
- `variantMap` — for COMPONENT_SET; maps variant property combination → prefab name.
- `assetMappings` — keys prefixed `imageRef-` for grep. Maps Figma image hashes to project asset paths.
- `skip: true` — explicit skip; validator/diff ignore this node.
- `notes` — free-text, preserved on write.

### v1 → v2 migration (in `shared/connect-map.mjs`)

v1 shape:
```json
{ "figmaNodeId": "1:23", "scenePath": [":", 0, ":", 2] }
```

Reader detects missing `version` field, wraps in v2 envelope:
```json
{
  "version": 2,
  "mappings": [
    { "figmaNodeId": "1:23", "scenePath": [":", 0, ":", 2] }
  ]
}
```

On next write, file is upgraded to v2 explicitly.

### Writer guarantees

- Preserves `notes` field verbatim.
- Preserves key order within each mapping (uses original JSON parser key iteration).
- Indentation auto-detected (tabs vs spaces).
- No reformatting unless field changed.

## CLI flags reference

### `apply-patch.mjs`

```
node apply-patch.mjs \
  --scene <path>              # scene JSON to modify
  --patch <path-or-stdin>     # patch JSON (or - for stdin)
  [--dry]                     # print intended writes, don't write
  [--allow-class-change]      # permit `c` or `r` mutations
  [--strict]                  # fail on any guard (default: skip with warning)
```

### `diff-snapshot.mjs`

```
node diff-snapshot.mjs \
  --figma <snapshot.json>     # from fetch-figma.mjs or figma-walker.mjs
  --scene <scene.json>
  [--connect <figma.connect.json>]
  [--threshold-px <n>]        # default 1
  [--threshold-scale <n>]     # default 0.01
  [--threshold-rot <n>]       # default 1 (degrees)
  [--strict]                  # all thresholds = 0
  [--report-json <path>]      # write JSON report
  [--auto-apply]              # chain into apply-patch.mjs (--dry → real)
  [--screenshot <path>]       # Workflow D — deferred, prints message
```

### `naming-validator.mjs`

```
node naming-validator.mjs \
  --figma <snapshot.json>
  [--scene <scene.json>]      # enables N006/R001 cross-checks
  [--project <path>]          # enables P001/T002 file existence checks
  [--json <out.json>]         # JSON output
```

### `generate-skeleton.mjs`

```
node generate-skeleton.mjs \
  --figma <snapshot.json>
  --out <path/to/out.{s,p}.json>
  [--prefab]
  [--project <path>]
  [--connect <figma.connect.json>]
  [--root-class Main|Scene|Container]
  [--orientation portrait|landscape]
  [--dry]
```

## Cross-links

- `scene-walker.mjs` output shape (drives `scenePath`): `scripts/scene-walker.mjs` — header comments
- `fetch-figma.mjs` output shape (drives `figmaId`): `scripts/fetch-figma.mjs` — header comments
- Naming convention (drives `matchedBy: "namePath"`): `naming-conventions.md`
- Validator rule codes (drives `flags.code`): `validator-rules.md`
- Generator rules (drives skeleton emission): `generator-rules.md`
