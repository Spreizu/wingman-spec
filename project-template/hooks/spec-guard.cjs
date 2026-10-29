#!/usr/bin/env node
// Prompt guard: block stock /opsx:* (or /opsx-*, Codex /prompts:opsx-*) commands that have a /spec-*
// equivalent in this package, and point the user at the schema-aware command. One decision function, three
// hook formats:
//   --format cursor (default)  Cursor beforeSubmitPrompt      -> {"continue":false,"user_message":...}
//   --format claude            Claude Code UserPromptSubmit   -> {"decision":"block","reason":...}
//   --format codex             Codex UserPromptSubmit         -> {"decision":"block","reason":...}
// Claude Code and Codex print nothing on allow (their plain stdout becomes model context).
// Managed by the wingman-spec schema package's install.sh; do not edit by hand. Fails open on any error.
//
// The decision logic is exported (evaluate, isInstalled) so the Wingman Spec editor extension applies the
// exact same rules to the prompts it sends to the agent. Running this file directly is the hook.
const fs = require("fs");
const path = require("path");

const ALTERNATIVES = {
  explore: "spec-explore",
  propose: "spec-propose",
  new: "spec-propose",
  continue: "spec-propose",
  ff: "spec-propose",
  apply: "spec-apply",
  sync: "spec-sync",
  archive: "spec-archive",
  update: "spec-fix",
};
// Not listed (e.g. verify, onboard) have no replacement and pass through.

const ALLOW = { continue: true };

/** Where each harness keeps the generated /spec-* entry point. */
const ENTRY_POINTS = [
  (r, n) => path.join(r, ".cursor", "commands", `${n}.md`),
  (r, n) => path.join(r, ".claude", "commands", `${n}.md`),
  (r, n) => path.join(r, ".agents", "skills", n, "SKILL.md"),
];

/** True when any harness's `<name>` entry point exists in any of the given workspace roots. */
function isInstalled(roots, name) {
  return roots.some((r) => ENTRY_POINTS.some((p) => fs.existsSync(p(r, name))));
}

/** Returns `{ continue: true }` or `{ continue: false, user_message }` for a submitted prompt. */
function evaluate(rawPrompt, roots) {
  const prompt = String(rawPrompt || "").trimStart();
  const m = prompt.match(/^\/(?:prompts:)?opsx[:-]([a-z-]+)/i);
  if (!m) return ALLOW;
  const alt = ALTERNATIVES[m[1].toLowerCase()];
  if (!alt) return ALLOW;

  // Only enforce where the package is installed in this workspace.
  if (!isInstalled(roots, alt)) return ALLOW;

  const rest = prompt.slice(m[0].length).trim();
  return {
    continue: false,
    user_message:
      `/${m[0].slice(1)} is blocked: this project uses the wingman-spec schema. ` +
      `Run /${alt}${rest ? " " + rest : ""} instead; it follows the schema end to end.`,
  };
}

/** Renders a decision in the given harness's hook output format ("" = allow silently). */
function render(result, format) {
  if (format === "claude" || format === "codex") {
    if (result.continue) return "";
    // Codex has no project slash commands; the /spec-* entry points are skills invoked as $spec-*.
    const reason = format === "codex" ? result.user_message.replace(/Run \/spec-/, "Run $spec-") : result.user_message;
    return JSON.stringify({ decision: "block", reason });
  }
  return JSON.stringify(result);
}

function main() {
  const i = process.argv.indexOf("--format");
  const format = i > 0 ? process.argv[i + 1] : "cursor";
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let result = ALLOW;
    try {
      const input = JSON.parse(raw || "{}");
      const roots =
        input.workspace_roots && input.workspace_roots.length
          ? input.workspace_roots
          : [process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()];
      result = evaluate(input.prompt, roots);
    } catch {
      result = ALLOW;
    }
    process.stdout.write(render(result, format));
    process.exit(0);
  });
}

module.exports = { ALTERNATIVES, evaluate, isInstalled, render };

if (require.main === module) main();
