**Design map (only when the input includes a design: an image, a prototype, a Figma/Sketch export or a screenshot to match).** The result must match the design with what the project already has: the same layout, hierarchy, spacing, colours, typography and components, not pixel-perfect. Map the design to the code BEFORE any proposal.

**If the design source is a Figma URL** (figma.com/design, /file, /proto, a branch link, any node-id), or the user asks to build or update something "from Figma", invoke the `figma-to-code` skill by name first. It reads Figma (MCP, then REST with `FIGMA_TOKEN`, then exported images) and picks BUILD (new) or UPDATE. UPDATE diffs the node against the code, and only changed rows become tasks. The skill does steps 1 and 2; continue at step 3 with what it returns. *Fallback if the skill is unavailable*: ask the user for exported images of each breakpoint and follow the steps below. List every number read off an image as an estimate.
1. **Discover the design system.** Run `.wingman-spec/bin/wingman-spec design-system` and read what it lists: token files (CSS custom properties, Tailwind `@theme` / `tailwind.config` theme and presets, `tokens.json` / style-dictionary output), UI library theme config (Nuxt UI `app.config`, shadcn CSS variables / `components.json`), and the shared components with their variants and props. Open the token files and the components you will need.
2. **Map every region and element of the design**, in this order of preference, and record the source of each mapping:
   1. `token`: a project/semantic token (colour, spacing step, radius, type style, shadow, breakpoint), e.g. `bg-primary`, `gap-gutter`, `rounded-card`, `text-title`;
   2. `component`: an existing project component and its variant/props, e.g. `UiCard highlighted`, `UiButton variant=secondary`;
   3. `framework`: a framework/library default, ONLY when the project defines nothing for it, e.g. `gap-6`, `text-sm`;
   4. `arbitrary`: an arbitrary value (`p-[13px]`, `#2563eb`) only as a last resort, ALWAYS also listed under Gaps with the reason.
   Never invent a value silently: a colour or size the design uses that no token matches is a gap (closest token + the question), not a new hex value.
3. **Write the map** to `explore-design/<slug>.md` in the specs root (exploration output; `/spec-propose` moves it into the change as `design-map.md`, and `wingman-spec lint` reads it there):

   ```markdown
   # Design map: <slug>
   Inputs: design/pricing-1280.png (1280px), design/pricing-375.png (375px)

   ## Design system
   - Tokens: src/style.css @theme (--color-primary #3b5bdb -> bg-/text-/border-primary, --spacing-gutter 2rem -> gap-gutter, ...)
   - Components: src/ui (UiCard highlighted, UiButton primary|secondary|ghost block, UiBadge primary|neutral, ...)

   ## Map
   | Region / element | Selector | Implemented with | Source | Expect |
   |---|---|---|---|---|
   | Plan list | `[data-testid="plan-list"]` | grid gap-gutter lg:grid-cols-3 | token: --spacing-gutter | gap ~ token:spacing-gutter |
   | Highlighted card | `[data-testid="plan-card"]` | UiCard highlighted (Team only) | component: UiCard | border-top-color ~ token:color-primary |
   | Price | `[data-testid="plan-amount"]` | text-display font-extrabold leading-none | token: --text-display | font-size ~ token:text-display; font-weight = 800; line-height ~ 48px |
   | Plan name | `[data-testid="plan-name"]` | text-lg font-semibold | framework: text-lg | font-size ~ 18px; font-weight = 600; line-height ~ 28px |

   ## Gaps
   - <element>: design uses <value>; no matching token (closest: <token>). Proposal: <...>. Question for the designer: <...>

   ## Questions for the designer
   - <only what the design does not answer: states, breakpoints, long text, empty/error looks>
   ```
   One row per region/element the specs will name: decide its `data-testid` selector here; the visual scenarios use exactly these selectors. **Every row gets at least one Expect fact**, and **every text element (headings, labels, names, prices, body copy, links, buttons with text) gets its typography: `font-size`, `font-weight` AND `line-height`** read from the design (with the colour where it differs from the body text). Use the token when the project has one (`font-size ~ token:text-display`); when it has none, write the literal design value (`font-size ~ 18px`, `line-height ~ 28px`, `color ~ #475569`) instead of leaving the fact out. The Expect column holds the checkable facts (token-level where possible) that become `expect:` lines in the specs: `<property> ~ <value>` (colour, gap, padding, font-size, font-weight, radius, text-transform ...) and relations (`align <a> left-with <b>`, `<a> before <b>`, `<a> above <b> @375`, `<a> same-height <b>`).
   Expect facts describe the design as loaded; when the design shows another state (hover, error, open drawer), put that state's facts indented under its `state:` in the visual block: block-level `expect:` lines are checked on the loaded page only.
   `wingman-spec lint` fails a map row with no `expect:` line on its selector in the specs, a text row without font-size, font-weight and line-height, and an Expect fact the specs do not carry.
4. Ask the user (or the designer) the Gaps and Questions you cannot resolve from the code; do not guess them.
