# Figma sources: setup, limits, fallbacks

## Which source gives what

| | MCP (official) | REST + `FIGMA_TOKEN` (helper) | Images only |
|---|---|---|---|
| Tree, layout (auto layout), text, instances | yes (`get_design_context`, `get_metadata`) | yes (`fetch`, then `facts`) | no, estimated by eye |
| Variable names (design tokens) | yes (`get_variable_defs`) | Enterprise plans only (`/variables/local`); otherwise styles + values | no |
| Code Connect (component to code mapping) | yes (`get_code_connect_map`) | no | no |
| Screenshot / assets | `get_screenshot`, `download_assets` | `--screenshot`, `--assets` (SVG/PNG) | what the user exports |
| Needs | a client with MCP + Figma login, Dev/Full seat | a personal access token (any plan) | nothing |

Use the first that works (SKILL.md section 1). Combine when useful: MCP for variables/Code Connect, REST for the exact normalised numbers.

## Option 1: Figma MCP server

Remote server URL: `https://mcp.figma.com/mcp` (sign in with the browser the first time). The remote server cannot read your selection: always pass a frame/layer link. Setup per harness:

- **Claude Code**: plugin (MCP + Figma skills): `claude plugin install figma@claude-plugins-official`. Manual: `claude mcp add --transport http figma https://mcp.figma.com/mcp` (add `--scope user` for all projects), then in Claude Code run `/mcp`, choose figma, **Authenticate**.
- **Codex CLI**: `codex mcp add figma --url https://mcp.figma.com/mcp`, then sign in when asked.
- **Cursor**: `/add-plugin figma` in chat, or `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global): `{"mcpServers":{"figma":{"url":"https://mcp.figma.com/mcp"}}}`, then *Settings, Tools & MCP, figma, Connect*.
- **VS Code** (Copilot): `.vscode/mcp.json`: `{"inputs":[],"servers":{"figma":{"url":"https://mcp.figma.com/mcp","type":"http"}}}`.

Limits (read tools): Dev/Full seat: Professional 200 calls/day and 10/min, Organization 200/day and 15/min, Enterprise 600/day and 20/min. View/Collab seats and Starter plans: 20 calls per month: use REST or images instead. So: one `get_design_context` per section, `get_metadata` first for big frames, never one call per element.

Rules for MCP output:
- `get_design_context` returns generated code (React + Tailwind by default). It is a **hint** for structure, text and assets, never pasted. Ask for the project's framework in the prompt if you use it, then still apply the map.
- `get_variable_defs` gives the names/values of variables and styles used in the node: this is the best input for the token mapping.
- `get_code_connect_map` shows which Figma component is which code component. If it is empty, fall back to name/variant matching.
- Always take one `get_screenshot` of the node as the visual target (temp file, not committed).
- `download_assets` returns temporary URLs: download the files into the project's asset folder, never reference the URL.

Framelink (`figma-developer-mcp`, local stdio server using your own token) works similarly (`get_figma_data`, `download_figma_images`); its README passes the key as an argument or `FIGMA_API_KEY`: prefer the env var.

## Option 2: REST API with FIGMA_TOKEN

1. Create a personal access token: Figma, *Settings, Security, Personal access tokens, Generate new token*, scope `file_content:read` (add `file_variables:read` on Enterprise for variable names). Figma shows the token once.
2. Make it available **to the shell that starts the agent** as an environment variable, without writing it into the repo:
   - macOS/Linux: `export FIGMA_TOKEN=...` in `~/.zshrc`/`~/.bashrc` (or your secret manager), then restart the editor/CLI so it inherits it.
   - Windows PowerShell: `setx FIGMA_TOKEN "..."` then restart.
   - Never put the token in `.env` files that are committed, `mcp.json`, chat messages or command arguments. The helper reads only the environment, sends it only as the `X-Figma-Token` header and removes it from any output.
3. Run (the agent does this): `node <skill-dir>/scripts/figma-fetch.mjs fetch "<figma url>" --assets`.

What the helper does and does not do: it fetches one node (`/v1/files/:key/nodes?ids=`), the file's local variables if the plan allows, optional SVG/PNG exports (`/v1/images/:key`), and caches the normalised result in `$TMPDIR/figma-to-code/<fileKey>-<nodeId>/` (reuse; `--refresh` to refetch). No retries: a 429 prints the wait (`Retry-After`), the plan tier and the upgrade link, and stops (exit 5). Exit codes: 0 ok, 1 failure, 2 usage, 3 no token, 4 HTTP error (403 invalid/expired token or no access, 404 file/node not found), 5 rate limited.

Rate limit (Tier 1 file endpoints): Dev/Full seat 10/min Pro, 15/min Org, 20/min Enterprise; View/Collab seats up to 20 per month. Fetch each node once.

Limits of the mapping: colours are matched to project tokens and to white/black only; the Tailwind stock palette (`blue-600`) is **not** matched automatically, so an untokenised colour shows as `arbitrary` and the agent must pick the stock colour by hand or ask the designer. Lengths, font sizes/weights, radii, borders and shadows are matched to the project's tokens, then to Tailwind's default scale (v3 or v4 as the project uses).

## Option 3: exported images / pasted screenshot

Ask for one export per breakpoint (PNG at 1x or 2x, or SVG for icons) and the frame width of each. Everything you read off an image is an **estimate**: spacing within ±2px, colours by eye, type size by cap height. Rules: prefer project tokens (the nearest by eye, then confirm with the user), use `~` in Expect facts, list every estimated value under Gaps/Questions ("estimated from an image, please confirm"), and never present estimated numbers as design values. Ask for the exact values of anything that does not map to a token.
