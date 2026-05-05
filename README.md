# Claude Skills — Thing-Editor + Figma Sync

Two related Claude Code skills for working with [Thing-Editor](https://github.com/Megabyteceer/thing-editor) projects (PixiJS v7 game engine with JSON-serialised scenes/prefabs):

- **`thing-editor`** — engine reference. Scene/prefab JSON format, component conventions, common gotchas (DSprite anchor 0.5, `super.init()`, `_onRenderResize`, scene-linked `Delay`/`Promise`, etc.).
- **`thing-editor-figma-sync`** — pulls a Figma frame, diffs it against a `.s.json` / `.p.json`, proposes minimal patches to align positions, sizes, fonts, tints, text. Supports free Framelink MCP, REST fallback, or paid Figma MCP.

The two skills are loosely coupled: `thing-editor-figma-sync` cites `thing-editor` as a prerequisite for engine knowledge, but the scripts are self-contained.

---

## ⚠️ Warning — Automated fixes can be wrong

These skills compute proposed changes and report them. **The proposals can be wrong.** Always review.

Common reasons a "fix" is incorrect:

- **Engine vs design intent diverge.** Figma is a mockup; the scene is functional. If Figma shows one bet display but the scene has seven preset bet buttons, the scene is right.
- **Pivot / anchor defaults differ by class.** `DSprite` and `MovieClip` default anchor 0.5, plain `Sprite` defaults 0,0, `SizedContainer` uses `normPivot*`/`normAnchor*` semantics. A coord-conversion mistake here shifts the whole patch.
- **Group vs Frame vs Auto-layout.** Figma Groups have no transform; Auto-layout positions are computed. Mismapping these breaks relative coords.
- **Texture base-size unknown.** Scaling a sprite needs the texture's native dimensions. Guessing produces wrong `scale.x`/`scale.y`.
- **Text scale on parent containers.** Pixi multiplies transforms; scaling any ancestor of a Text node blurs the rasterised glyphs. Adjust `style.fontSize` instead, never parent scale.
- **Scene structure deeper than the design mockup.** Walker output covers what's in the file; prefab refs (`r:`) bring in children resolved at runtime — those are not visible to the diff.

Skill rule: **analysis-first, never auto-patch.** The skill prints a structured findings report; you (the human) review the math and explicitly approve before any patch is written. Even then, the patcher runs `--dry` first and waits for second confirmation. Do not bypass these gates.

If a proposed value looks off, it usually is. Push back.

---

## Installation

Skills live in `~/.claude/skills/`. Clone this repo there:

```bash
mkdir -p ~/.claude
git clone https://github.com/<user>/<repo>.git ~/.claude/skills
```

Or if you already have a `~/.claude/skills/` directory, clone into a sibling and merge:

```bash
git clone https://github.com/<user>/<repo>.git /tmp/skills-repo
cp -r /tmp/skills-repo/thing-editor /tmp/skills-repo/thing-editor-figma-sync ~/.claude/skills/
```

Restart Claude Code (or start a fresh session). The skills should appear in the available-skills list. Trigger them with `/thing-editor` or `/thing-editor-figma-sync`, or by mentioning a Thing-Editor project.

### Figma access (only required for `thing-editor-figma-sync`)

The skill prefers free sources first.

**1. Framelink MCP (free, recommended)** — [glips/figma-context-mcp](https://github.com/glips/figma-context-mcp). Register once:

```bash
claude mcp add figma-framelink -s user \
  -e FIGMA_API_KEY='figd_your_personal_access_token' \
  -- npx -y figma-developer-mcp --stdio
```

Get a Figma personal access token at [figma.com → Settings → Personal access tokens](https://www.figma.com/developers/api#access-tokens) with scope **File content: read**.

**2. REST script (no MCP)** — `thing-editor-figma-sync/scripts/fetch-figma.mjs`. Same token via `FIGMA_TOKEN` env var. Useful for batch/CI.

**3. Paid Figma MCP** — last resort. Costs money. Only use if you need Code Connect / screenshot tools the free MCP lacks.

---

## Use cases

### thing-editor-figma-sync

- "Match this scene to the Figma frame: `https://figma.com/design/...?node-id=1663-54181`. Scene: `tableCreateScreen`."
- "Fix pixel-perfect alignment of `mainMenuScreen.s.json` against `Main Menu` frame."
- "Update text tints in `lobbyScreen` from the Figma design."
- "Import this Figma frame as a new prefab."

The skill walks the scene, fetches the Figma node tree, matches by composite name (`parent/child`) or Code Connect map, computes a diff, prints a findings report, and waits for your approval before patching.

### thing-editor

Loaded automatically when you mention Thing-Editor concepts. Provides:

- Scene/prefab JSON shape (`c` = class, `p` = props, `:` = children, `r` = prefab ref)
- Component reference (Button, Shape, Toggle, ProgressBar, MovieClip, ShapeButton, DSprite, Spine, ParticleContainer, NineSlicePlane, …)
- Lifecycle gotchas (`super.init()`, `_onRenderResize`, `RemoveHolder`)
- Animation primitives (`MovieClip`, `TickerTween`, `Delay`)

---

## Repo layout

```
.
├── README.md
├── thing-editor/
│   ├── SKILL.md
│   └── references/
│       └── engine-reference.md
└── thing-editor-figma-sync/
    ├── SKILL.md
    ├── references/
    │   └── coord-mapping.md
    └── scripts/
        ├── scene-walker.mjs    # parse .s.json/.p.json into flat path-keyed map
        ├── apply-patch.mjs     # minimal-edit JSON patcher (preserves key order/whitespace)
        └── fetch-figma.mjs     # REST-based Figma fetcher (no MCP needed)
```

---

## Contributing / customising

These skills are documentation + small Node scripts. Edit `SKILL.md` to change the workflow Claude follows; edit the scripts for parser/patcher behaviour. Commit your changes — skills are versioned like any code.

Open issues / PRs welcome.
