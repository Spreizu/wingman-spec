# Recipe: Figma node to design-map rows

How to turn what the source returned into the rows, Expect facts and tasks of the OpenSpec design map. The map format and the checks are the ones of the `design-map` partial of `/spec-explore`; this file only says how to read Figma into them.

## Value to implementation (per fact)

| Figma | Look for first | Then | Last resort |
|---|---|---|---|
| Fill / stroke colour (variable or style `color/primary`) | project colour token of the same name/meaning, else the same value (`bg-primary`) | white/black, or ask which stock Tailwind colour | `bg-[#12ab34]` + Gap |
| Text style (`Heading/Title`: size, weight, line height) | project type token (`text-title`) | `text-sm`, `font-semibold`, `leading-6` | `text-[17px]` + Gap |
| Auto layout gap / padding | spacing token (`gap-gutter`, `p-card`) | stock step (`gap-4` = 16px) | `gap-[13px]` + Gap |
| Corner radius | radius token (`rounded-card`) | `rounded-lg` | `rounded-[7px]` + Gap |
| Effect (drop shadow) | shadow token (`shadow-card`) | `shadow-md` | arbitrary + Gap |
| Width/height | content/fill (`w-full`, `max-w-*` token) | fixed only for icons/images/avatars | fixed px + Gap |
| Opacity, blur | token | stock (`opacity-50`) | arbitrary + Gap |

`lint` prints info lines such as "raw value equal to --radius-card; prefer token:radius-card" for a `font-size ~ 14px`: they compare numbers only, so check the meaning (a font size is not a radius) before following them.

A value within the visual check's tolerance of a token is that token (1px off a token is the token; colours within roughly deltaE 6). A name match with a **different** value is `drift`: keep the token, add a Question ("design says 10px, our `radius-control` is 12px: update the design or the token?").

## Components and variants

- Figma instance to the project component: `Button` + `Variant=secondary, Size=md` to `UiButton variant="secondary"`. Use Code Connect when there is some; otherwise name, then the variant property names/values, then the design-system listing (`verify-task.cjs design-system`) for props.
- A variant the component lacks (a new `danger` look) is a Gap: propose the variant on the component, do not restyle one instance with raw classes.
- Do not rebuild a component from its Figma layers. Its internals are the component's job; the map row is the component with its props, and facts only for what the instance changes (width, margin).
- A repeated structure (cards, list rows) becomes one component/loop fed by data, not N copies; take texts from the project's data/content layer when it exists.

## Layout

Auto layout: direction to `flex-col`/`flex-row`, gap to `gap-*`, padding to `p-*`, main/cross alignment to `justify-*`/`items-*`, wrap to `flex-wrap`, "fill" to `flex-1`/`w-full`, "hug" to no width. Prefer grid for equal columns. Frames without auto layout: infer from positions (rows, columns, equal gaps), record the inference under Questions, never use `absolute`/offsets for flow content (only for real overlays: badges, decorative layers; say so in the row).

## Responsive

- One Figma frame per breakpoint. Map each frame width to the project's breakpoints (`sm:` 640, `md:` 768, `lg:` 1024 in stock Tailwind; check the project's `@theme --breakpoint-*`). The smallest frame is the base style, larger ones add `md:`/`lg:` overrides, only where they differ.
- Expect facts for properties that differ per frame carry the viewport: `... @375`, `... @>=1024` (the visual block's `viewports:` must include them).
- Only one frame (desktop)? Do not invent the mobile look. Make it fluid with the same components, record "mobile not designed" under Questions.
- Fixed pixel widths from the frame become `max-w-*`/fill, not a fixed width.

## States and variants

Figma shows states as variants/prototype frames (hover, focus, disabled, error, open, loading, empty). Components already implement their states: use the variant props. States of your own markup go into the specs as `state:` blocks of the visual block with their facts indented under it; the loaded-page facts stay at block level. A state the design does not show: Question, not a guess.

## Text and i18n

Take copy from the design exactly once, into the project's content layer (i18n keys/messages, CMS/data files, props); no hard-coded strings if the project has i18n. Placeholder copy ("Lorem ipsum", "Label") is not real copy: mark it in Questions. Long text, truncation and wrap: the design shows one length; use the project's text utilities (`truncate`, `line-clamp-*`) only if the design clearly truncates, else let it wrap. Never rely on a font that the project does not load: Gap if the design's font family is not in the project (check `font-family` tokens).

## Assets

- Reuse what exists (the project's icon set/component, image folder). Match an icon by name (`Icon/Check`) to the project's icon first.
- Export only what is missing: SVG for icons/vectors (inline or as the project does), PNG/JPG/WebP for photos at 2x, placed in the project's asset folder with kebab-case names. Optimise as the project does (no new tooling).
- No `figma.com`/`api.figma.com` URLs and no temporary asset URLs in the code. Add `alt` text from the layer/design intent, empty `alt` for decoration.

## Accessibility

Choose elements by role, not by look: headings in outline order (not by font size), `button`/`a` by behaviour, `ul/li` for lists, `label`/`for` for form fields, landmarks (`header`, `nav`, `main`). Name icon-only controls (`aria-label`). Check contrast on text/background pairs; a failing pair in the design is a Question for the designer (the visual check runs axe and will flag it). Respect the design's focus and disabled looks through the components' own states.

## Expect facts, from the numbers

- Text: `font-size`, `font-weight`, `line-height` always; `color` where it differs from body text; `text-transform`/`letter-spacing` when set.
- Boxes: `background-color`, `border-radius`, `border-top-color`/`border-top-width`, `box-shadow` (only when it is not a token), `padding-*`, `gap` (container), icon/image `width`/`height`.
- Relations: order (`a before b`), alignment (`a left-with b`), stacking at a width (`a above b @375`), equal heights (`a same-height b`).
- Use `token:<name>` where a token matches (checks the token's value, so a later token change keeps passing); literal values otherwise. `~` = tolerance, `=` = exact (use for font-weight and fixed values).
- Not every Figma number is a fact. Facts are for what must hold for the page to look the same: skip decorative micro-values (a 1px hairline offset) and values the framework controls.

## Update mode: the diff table

For each selector in the node: for each Expect fact, compare the Figma value with what the code computes today.

```markdown
## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | `[data-testid="account-name"]` | color | #3b5bdb | #1b1f2a | changed | `text-fg` to `text-primary` |
| Account name | `[data-testid="account-name"]` | font-weight | 700 | 600 | changed | `font-semibold` to `font-bold` |
| Account text | `[data-testid="account-text"]` | gap | 8px | 4px | changed | `gap-1` to `gap-2` |
| Account name | `[data-testid="account-name"]` | font-size | 28px | 28px | same | not edited |
```

Status: `same` (within 0.5px/exact colour), `close` (inside the checker's tolerance: not edited), `changed` (task), `unknown` (code value not read yet: read it). Resolve classes through the project tokens to compare values (`gap-1` is 4px in stock Tailwind; `p-card` is the token's value). Only `changed` rows become tasks; each task names the line/class and the new class or token. Anything that is not in a `changed` row stays byte-for-byte as it is. New or removed elements are separate rows and a Question, not an edit.
