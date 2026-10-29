---
name: figma-to-code
description: >
  Build or update a page, section or component from a Figma link. Use when the user gives a figma.com URL (any
  node-id), says "build/implement/update/sync this from Figma", or /spec-explore gets a Figma design source. Reads
  Figma via MCP, REST with FIGMA_TOKEN, or images; writes the design map with checkable Expect facts.
argument-hint: "<figma-url> [build|update]"
license: MIT
---

# Figma to code

The designer produced the design; you implement it with the project's own tokens, components and framework classes.
The result must be **recognisably the same** (layout, hierarchy, spacing, colours, typography, components), not
pixel-perfect and never a paste of Figma's generated code.

`<skill-dir>` below is the folder that holds this SKILL.md (`.cursor/skills/figma-to-code`,
`.claude/skills/figma-to-code` or `.agents/skills/figma-to-code`). Details live in `references/`:
`figma-sources.md` (MCP / REST / images, limits, setup), `design-map-recipe.md` (value to class rules, responsive,
states, assets, i18n, accessibility, update diff).

## 0. Input and mode

1. Get the Figma link. If the user gave none (or only a file link with no `node-id`), **ask** for a link to the frame
   or section (Figma: right-click the frame, *Copy link to selection*). Do not fetch a whole file.
2. Parse it: `node <skill-dir>/scripts/figma-fetch.mjs parse-url "<url>"` gives `fileKey`, `nodeId` (`1-2` and
   `1%3A2` both become `1:2`), the kind and warnings. It accepts `design/`, `file/`, `proto/`, `board/`, branch
   (`/branch/<branchKey>/`: the branch key is the file key) and embed links. A FigJam `board/` or a Slides/Make file
   is not a UI design: ask for a design frame.
3. Pick the mode (say which one you chose, in one line):
   - **BUILD**: the page/section/component does not exist in the code yet.
   - **UPDATE**: it exists and the design changed, or the user says update/sync/match. The Figma node is compared with
     the current code and **only the differences** are changed. If unsure which, search the code for the node's texts
     and layer names; found means UPDATE.
4. One link = one scope. Work on the requested node only. Differences outside it are noted in the map's Questions,
   never edited.

## 1. Get the design (source ladder: use the first that works, say which one you used)

| # | Source | How | Notes |
|---|---|---|---|
| 1 | **Figma MCP** (official remote/desktop server, or Framelink) | If a Figma server is connected (tools such as `get_design_context`, `get_variable_defs`, `get_screenshot`, `get_metadata`, `download_assets`; Framelink: `get_figma_data`, `download_figma_images`): call it with the `fileKey` and `nodeId`. | Variables + Code Connect + screenshot. Rate limited and needs a Dev/Full seat: one call per section, never per element. Treat the returned code as a **hint** (see rules). |
| 2 | **REST API** with `FIGMA_TOKEN` | `node <skill-dir>/scripts/figma-fetch.mjs fetch "<url>" --assets` | Needs the env var `FIGMA_TOKEN` (never ask the user to paste it into chat or a file). Output goes to a temp dir; cached. Variable names need an Enterprise plan on REST; styles and values always work. |
| 3 | **Exported images** / pasted screenshot | The user exports the frame(s) (PNG/SVG), one per breakpoint. | Every number is an **estimate**: list them as such in the map, prefer tokens, ask the designer for exact values of anything that does not match a token. |

Detect the source without printing secrets: MCP = look at your tool list; REST = run the helper (it says "FIGMA_TOKEN
is not set" when there is none; relay that message, it tells the user how to create one and what the alternatives are).
If neither works, do not stop: continue with source 3 and say what was lost. Never write the token anywhere.

What to collect for the node: the tree (frames, auto layout, text, instances), variables and styles used, component
instances with their variant properties, text content, exportable assets, and one **screenshot as the visual target**
(a temp file, never committed). Big node (many screens/sections): get the outline first (`get_metadata`, or the
helper's `--depth 2`), then fetch section by section. One frame per breakpoint: collect each with its width.

With the REST helper, turn the response into facts the map can use:

```bash
H="node <skill-dir>/scripts/figma-fetch.mjs"
$H fetch "<url>" --assets --collapse-instances          # prints a summary; OUT = its "out" dir (node.json = normalised tree, facts.json, assets/)
node <code-repo>/openspec/scripts/verify-task.cjs design-system --format json > "$OUT/design-system.json"
$H facts "$OUT/node.json" --design-system "$OUT/design-system.json" --at <frame-width>   # token > stock > arbitrary per value
```

`facts` lists, per layer, each value with how it should be implemented:
- `via: token` (with the token and its class), `framework` (stock Tailwind class) or `arbitrary` (a gap);
- `internal: true` for a leaf component (Button/Badge/Input-like, with no other component inside) and its layers. Map the
  component and its props, and keep facts there only for overrides. A Card-like instance holds page content, so its
  layers keep their facts;
- `drift` when a Figma variable/style names a token whose value differs.

 It is a mapping aid, not a decision: you check names and meaning. For MCP or image sources you do the
same mapping by hand with the same ladder.

## 2. Map the design to the code BEFORE planning

Follow the `design-map` flow of `/spec-explore` (it is in the explore command; steps 1 to 4). In short, with the Figma specifics:

1. Run `node <code-repo>/openspec/scripts/verify-task.cjs design-system` and open the token files and the shared components you will need.
2. For **every** region, text and component of the node, in this order, and record the source:
   1. **token**: Figma variable/style names (`color/primary`, `spacing/card`, `Heading/Title`, or their `codeSyntax.WEB`) to the project's token of the same meaning, else the token with the same value. A same-value token with a different meaning (a gap that happens to equal a card padding) is only a candidate: check the name/role. `drift` rows are questions for the designer, not silent changes.
   2. **component**: Figma component/variant to the project's component and variant props (`Button / Variant=secondary` to `UiButton variant="secondary"`). Code Connect mappings (`get_code_connect_map`, `*.figma.tsx` files) are authoritative when present; otherwise match by name, variants and the design-system listing. Reuse the component; do not rebuild its internals from the Figma layers.
   3. **framework**: a stock value (`gap-4`, `text-sm`, `rounded-lg`) only where the project defines nothing.
   4. **arbitrary**: `p-[13px]`, a raw hex: last resort, **always also listed under Gaps** with the closest token and the question for the designer. Never invent a new token or hex silently.
3. Layout: Figma auto layout is flex/grid: direction, gap, padding, alignment, hug/fill/fixed become `flex`, `gap-*`, `p-*`, `items-*`, `w-full`/content width. A frame **without** auto layout has no layout to copy: infer rows/columns/grids from the child positions, say so in Questions, and never emit `absolute`/`top-*`/`left-*` or pixel offsets for normal flow.
4. Also decide, per `references/design-map-recipe.md`:
   - responsive behaviour: map the frames per breakpoint to the project's breakpoints;
   - states and variants (hover, disabled, error) as `state:` blocks;
   - text content and i18n: use the project's i18n if it has one, no hard-coded copy;
   - assets: reuse existing ones. Export only what is new, into the project's asset folder and icon convention. No temporary Figma URLs in code, no new icon package;
   - accessibility: semantic elements and labels from the design's roles. Contrast questions go to the designer.

## 3. Write the design map

Write `<root>/openspec/explore-design/<slug>.md` in the exact format of the `design-map` partial (`# Design map`,
`Inputs:`, `## Design system`, `## Map` with Region | Selector | Implemented with | Source | Expect, `## Gaps`,
`## Questions for the designer`). Figma-specific content:

- `Inputs:` the Figma link (without tokens), file key, node id, `lastModified`/`version` if known, the source used (MCP / REST / images), and the frame width(s).
- Selectors are the project's existing `data-testid`s in UPDATE mode; in BUILD mode you choose them (kebab-case, from the layer names; `facts` suggests them).
- **Expect** facts come from the Figma numbers: for every text `font-size`, `font-weight` AND `line-height`; colour where it differs from body text; `gap`, `padding`, `border-radius`, `background-color`, fixed icon/image sizes; relations for order and alignment (`a before b`, `a above b @375`, `a same-height b`). `facts` prints each as `expect` (`token:<name>` where a token matches, otherwise the literal value). Add `@<width>` to facts that hold only at one breakpoint. Estimated values (source 3) get `~` and are named in the Gaps/Questions.
- Gaps: every `arbitrary` row, every `drift`, every value you could only estimate.

Ask the user/designer for the Gaps and Questions you cannot resolve from the code. Do not guess them.

## 4. BUILD mode

1. The map above is the plan input: `/spec-propose <slug>` attaches it to the change (specs carry the `expect:` lines, tasks carry `Visual:`).
2. Implement section by section with the map's "Implemented with" column; components first, then composition. Text from the design goes through the project's i18n/content layer if it has one.
3. Do not copy the generated code of `get_design_context` (it is React + Tailwind with raw values and often absolute positioning). Use its structure, text and asset list as hints only, translated to the project's stack and tokens.
4. Verify (section 6).

## 5. UPDATE mode (change only what differs)

1. Find the code for the node (route, component, `data-testid`s). Read it and the tokens: you need the **current value** of every fact below.
2. Build the diff table for the node: one row per fact, Figma value vs current value in the code (resolve classes through the tokens: `p-card` is 28px). With a values file, the helper does the comparison:
   ```bash
   $H diff "$OUT/facts.json" code-values.json --md     # code-values.json: { "<testid>": { "gap": "4px", "font-weight": "600" } }
   ```
   The helper's `Selector` column is the suggested id: write the real selectors (`[data-testid=...]`, or a structural one such as `[data-testid="account-overview"] h2` when the element has no test id; do not edit markup just to add ids). Status: `same`, `close` (within the visual check's tolerance), `changed`, `unknown` (go and read the code; do not guess). Alternative: put the Figma `expect:` lines into the change's visual block first and run `verify-task.cjs visual`; the failing expects are the changed rows (this is the red step).
3. Write the map as in section 3 (it covers the whole node, so lint and the visual check keep guarding untouched areas) and add a `## Diff vs current code` section with the table. **Only `changed` rows become tasks**, each with the exact class/token to set (`text-fg` to `text-primary`, `font-semibold` to `font-bold`, `gap-1` to `gap-2`). Rows that are `same` or `close` are listed as "not edited".
4. Edit only those lines. Keep markup, classes, texts, tests and anything outside the diff intact; no reformatting, no opportunistic cleanups. If a changed value has no token: gap, as in BUILD.
5. If a node exists in Figma but not in the code (new element) or the reverse (removed): list it as a separate row and ask, because it may be a design decision outside the update.

## 6. Verify (hand-off to the existing loop)

Run what the project already runs, nothing new: the task's `Done when` command, then
`node <code-repo>/openspec/scripts/verify-task.cjs visual <change>` (computed-style `expect:` checks, overflow, axe,
console errors; it needs Playwright, `doctor` says if it is missing) and the finish/review steps of the OpenSpec
apply flow. Use the Figma screenshot only as a temp file for your own side-by-side look (or the reviewer's rubric);
**never commit it** and do not add a `reference:` to a path that does not exist in the repo. Fix, re-run. If the
check could not run (no browser), say so and list the Expect facts that are still unverified.

## Rules

- Tokens, then components, then framework values; arbitrary values only as flagged gaps. "Pixel-perfect" is not the goal; a value that is 1px off a token is the token.
- Never absolute-position normal flow, never dump pixel offsets, never paste Figma's generated code or its CSS.
- No temporary Figma/asset URLs in code. No new icon/UI package. Export only assets the project lacks.
- The token is only read from `FIGMA_TOKEN`; never put it on a command line, in a file, in the map, in logs or in chat. If the user pastes one, tell them to revoke it.
- Respect the rate limit: one fetch per node, reuse the cache (`--refresh` only when the design changed), prefer MCP/REST once over many small calls.
- State what you could not see: hover/disabled/error states the design lacks, a breakpoint with no frame, text that is placeholder copy. These go to Questions, not into guesses.
- Estimated values (images only) are labelled as estimates everywhere they appear.
