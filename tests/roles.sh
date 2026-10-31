#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Visual roles: log in as different users so gated features are checked (role:, absent:, redirects-to:), and the secrets
# stay out of output and files. Needs the wingman-spec binary (tests/lib/ws.sh), node, Playwright + axe-core (PLAYWRIGHT_NODE_MODULES) for the browser part.
# Usage: tests/roles.sh. Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || head -c 1800 "$T/v.json" "$T/v.err" 2>/dev/null; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
SEC_ADMIN='adm-S3cret-pw!x'; SEC_VIEWER='vwr-Pa55word-zz'; SEC_OPS='ops-L0cal-file-q'

echo "== roles config (no browser)"
cd "$T" && mkdir p && cd p && git init -q && "$WS" init >/dev/null
git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
expect "init ignores .wingman-spec/local/ in .wingman-spec/.gitignore and does not touch the project .gitignore" 'grep -qx "local/" .wingman-spec/.gitignore && { [ ! -e .gitignore ] || ! grep -q "local\|\.auth" .gitignore; }'
"$WS" init >/dev/null 2>&1
expect "running init again keeps .wingman-spec/.gitignore as it is" '[ "$(grep -cx "local/" .wingman-spec/.gitignore)" = 1 ] && [ -z "$(git status --porcelain)" ]'
V="$WS"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
cp "$PKG/tests/fixtures/roles/app.js" app.js
setcfg() { # setcfg <roles block>: writes the visual section
  node -e '
const fs=require("fs"); let t=fs.readFileSync(".wingman-spec/wingman-spec.yaml","utf8");
t=t.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: node app.js "+process.argv[1]+"\n  url: http://127.0.0.1:"+process.argv[1]+"/\n  ready_timeout: 20\n  screenshots: off\n"+process.argv[2]);
t=t.replace(/Test command: <fill in>/,"Test command: none").replace(/Typecheck command: <fill in>/,"Typecheck command: none").replace(/Lint command: <fill in>/,"Lint command: none");
fs.writeFileSync(".wingman-spec/wingman-spec.yaml",t);' "$PORT" "$1"
}
ROLES='  roles:
    admin:
      login: /login
      success: /dashboard
    viewer:
      login: /login
      user_env: VIEWER_LOGIN
      password_env: VIEWER_SECRET
      success: [data-testid="welcome"]
    ops:
      login: /login
      success: /dashboard
'
setcfg "$ROLES"
export WINGMAN_ROLE_ADMIN_USER=admin@example.test WINGMAN_ROLE_ADMIN_PASSWORD="$SEC_ADMIN" VIEWER_LOGIN=viewer@example.test VIEWER_SECRET="$SEC_VIEWER"
export APP_ADMIN_USER=admin@example.test APP_ADMIN_PASSWORD="$SEC_ADMIN" APP_VIEWER_USER=viewer@example.test APP_VIEWER_PASSWORD="$SEC_VIEWER" APP_OPS_USER=ops@example.test APP_OPS_PASSWORD="$SEC_OPS"
$V doctor > "$T/doc.json" 2>&1; rc=$?
expect "doctor lists the roles and what each needs (names only)" 'grep -q "\"role\": \"admin\"" "$T/doc.json" && grep -q "WINGMAN_ROLE_OPS_USER" "$T/doc.json" && grep -q "\"role\": \"viewer\"" "$T/doc.json"'
expect "doctor shows admin and viewer ready and ops missing (no env, no local file)" 'node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));const r=Object.fromEntries(j.visual.roles.map(x=>[x.role,x.ready]));process.exit(r.admin&&r.viewer&&!r.ops?0:1)" "$T/doc.json"'
expect "doctor never prints a secret" '! grep -qF "$SEC_ADMIN" "$T/doc.json" && ! grep -qF "$SEC_VIEWER" "$T/doc.json"'
mkdir -p .wingman-spec/local; printf 'ops:\n  user: ops@example.test\n  password: %s\n' "$SEC_OPS" > .wingman-spec/local/roles.yaml
$V doctor > "$T/doc.json" 2>&1
expect "the gitignored local file satisfies a role (doctor: ops ready via local-file)" 'node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));const r=j.visual.roles.find(x=>x.role===\"ops\");process.exit(r.ready&&r.source===\"local-file\"?0:1)" "$T/doc.json" && ! grep -qF "$SEC_OPS" "$T/doc.json"'
expect "the local credentials file is not tracked by git" '[ -z "$(git status --porcelain --untracked-files=all | grep "local/")" ]'

git add -f .wingman-spec/local/roles.yaml >/dev/null 2>&1
rc=0; $V doctor > "$T/doc.json" 2>&1 || rc=$?
expect "doctor fails when the local credentials file is tracked by git, without printing it" '[ $rc = 1 ] && grep -q "tracked by git" "$T/doc.json" && ! grep -qF "$SEC_OPS" "$T/doc.json"'
git rm -q --cached .wingman-spec/local/roles.yaml
rm -f .wingman-spec/local/.gitignore; git rm -q --cached .wingman-spec/.gitignore; rm .wingman-spec/.gitignore; $V doctor > "$T/doc.json" 2>&1
expect "a credentials file in a checkout without .wingman-spec/.gitignore is ignored again from the first read" '[ "$(cat .wingman-spec/local/.gitignore)" = "*" ] && [ -z "$(git status --porcelain --untracked-files=all | grep "local/")" ]'
# role:, absent: and redirects-to: parse: internal/visual TestRoleGrammar
# a password written in config.yaml is refused, and never echoed
setcfg "$ROLES"; sed -i 's|^    admin:$|    admin:\n      password: hunter2-in-config|' .wingman-spec/wingman-spec.yaml
rc=0; $V doctor > "$T/doc.json" 2>&1 || rc=$?
expect "a password key in config.yaml is a config problem that names the env vars, not the value" '[ $rc = 1 ] && grep -q "credentials must not be written" "$T/doc.json" && ! grep -q "hunter2-in-config" "$T/doc.json"'
setcfg "$ROLES"; sed -i 's|^    admin:$|    admin:\n      colour: red|' .wingman-spec/wingman-spec.yaml
rc=0; $V doctor > "$T/doc.json" 2>&1 || rc=$?
expect "an unknown role field is a config problem" '[ $rc = 1 ] && grep -q "unknown field" "$T/doc.json"'
setcfg "$ROLES"

mkchange() { # mkchange <spec scenario blocks>
  rm -rf .wingman-spec/changes/demo .wingman-spec/runs; mkdir -p .wingman-spec/changes/demo/specs/gate
  printf '## Why\nRole contract tests for the visual check.\n\n## What Changes\n- Adds gated pages.\n\n## Edge cases\n- none named\n' > .wingman-spec/changes/demo/proposal.md
  printf '## ADDED\n\n### Requirement: Gated pages\nThe system SHALL show each page only to the roles that may see it.\n\n%s\n' "$1" > .wingman-spec/changes/demo/specs/gate.md
  printf '## 1. Gate\n- [ ] 1.1 Pages\n  - Spec: gate > Gated pages\n  - Files: app.js\n  - Visual: all\n  - Done when: `true`\n' > .wingman-spec/changes/demo/tasks.md
}
sc() { printf '#### Scenario: %s\n- **WHEN** the page is opened\n- **THEN** it behaves as stated\n\n```visual\n%s\n```\n\n' "$1" "$2"; }
mkchange "$(sc 'Ghost' $'route: /\nrole: nobody\nkey: [data-testid="x"]')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint rejects a role that visual.roles does not define" '[ $rc = 1 ] && grep -q "is not defined under visual.roles" "$T/l.json"'
mkchange "$(sc 'Two' $'route: /\nrole: admin\nrole: viewer\nkey: [data-testid="x"]')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint rejects two roles in one block (one scenario per role)" '[ $rc = 1 ] && grep -q "one role per visual block" "$T/l.json"'
mkchange "$(sc 'Typed' $'route: /login\nkey: [data-testid="login-form"]\nstate: typed\n  do: fill input[type=password] = hunter2')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint flags a step that types a password into a field" '[ $rc = 1 ] && grep -q "fills a password field" "$T/l.json"'
mkchange "$(sc 'Bad redirect' $'route: /\nredirects-to: login\nkey: [data-testid="x"]')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint rejects redirects-to without a leading slash" '[ $rc = 1 ] && grep -q "redirects-to must be a path" "$T/l.json"'

echo "== roles in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A >/dev/null 2>&1; git commit -qm cfg >/dev/null 2>&1
  GOOD=""; add() { GOOD+="$(sc "$1" "$2")"$'\n\n'; }
  add 'Admin panel' $'route: /admin\nrole: admin\nviewports: 375, 1280\nkey: [data-testid="admin-panel"]'
  add 'Viewer dashboard' $'route: /dashboard\nrole: viewer\nviewports: 375, 1280\nkey: [data-testid="welcome"]\nabsent: [data-testid="admin-link"]'
  add 'Viewer cannot open admin' $'route: /admin\nrole: viewer\nviewports: 1280\nredirects-to: /dashboard\nkey: [data-testid="welcome"]'
  add 'Anonymous is sent to login' $'route: /admin\nviewports: 1280\nredirects-to: /login\nkey: [data-testid="login-form"]'
  add 'Ops from local file' $'route: /dashboard\nrole: ops\nviewports: 1280\nkey: [data-testid="welcome"]'
  REPORT() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report)' "$T/v.json"; }
  mkchange "$GOOD"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "each role sees its own pages: admin panel, viewer without the admin link, redirects, ops via the local file (clean)" '[ $rc = 0 ] && grep -q "\"result\": \"clean\"" "$T/v.json"'
  expect "the report records the roles and how they logged in, never the session" 'node -e "const r=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));process.exit(r.roles.admin.ok&&r.roles.admin.via===\"login\"&&r.roles.ops.ok?0:1)" "$(REPORT)" && ! grep -rq "sid=" .wingman-spec/runs'
  expect "the session files are in .wingman-spec/local/auth/ with mode 600 and ignored by git" '[ "$(stat -c %a .wingman-spec/local/auth/admin.json)" = 600 ] && [ -z "$(git status --porcelain --untracked-files=all | grep "local/")" ]'
  expect "no password appears in the output of the run" '! cat "$T/v.json" "$T/v.err" | grep -qF -e "$SEC_ADMIN" -e "$SEC_VIEWER" -e "$SEC_OPS"'

  mkchange "$(sc 'Viewer wrongly sees admin' $'route: /admin\nrole: viewer\nviewports: 1280\nkey: [data-testid="admin-panel"]')"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: a role that cannot see a feature fails its key element check" '[ $rc = 1 ] && grep -q "defects" "$T/v.json"'
  mkchange "$(sc 'Admin link must be absent' $'route: /dashboard\nrole: admin\nviewports: 1280\nkey: [data-testid="welcome"]\nabsent: [data-testid="admin-link"]')"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: absent: fails when the element is visible to the role" '[ $rc = 1 ] && grep -q "role:forbidden-visible" "$(REPORT)"'
  mkchange "$(sc 'Anonymous expects dashboard' $'route: /admin\nviewports: 1280\nredirects-to: /dashboard\nkey: [data-testid="login-form"]')"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: redirects-to fails when the route ends elsewhere" '[ $rc = 1 ] && grep -q "role:no-redirect" "$(REPORT)"'

  mkchange "$(sc 'Admin panel' $'route: /admin\nrole: admin\nviewports: 1280\nkey: [data-testid="admin-panel"]')"
  rc=0; WINGMAN_ROLE_ADMIN_PASSWORD='wrong-Passw0rd-zzz' $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: a wrong password fails the login with a clear message, a temp screenshot and no secret" '[ $rc = 1 ] && grep -q "role:login-failed" "$(REPORT)" && ! cat "$T/v.json" "$T/v.err" "$(REPORT)" | grep -qF "wrong-Passw0rd-zzz"'
  shot="$(grep -oE "/[^ ;\"]*wingman-login-[^ ;\"]*\.png" "$(REPORT)" | head -1)"
  expect "the failure screenshot is in the system temp dir, not in the repository" '[ -n "$shot" ] && [ -f "$shot" ] && case "$shot" in "$PWD"/*) false;; *) true;; esac'
  rc=0; env -u WINGMAN_ROLE_ADMIN_PASSWORD $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: missing credentials say which env vars / file to set and that nothing was verified" '[ $rc = 1 ] && grep -q "role:no-credentials" "$(REPORT)" && grep -q "WINGMAN_ROLE_ADMIN_PASSWORD" "$(REPORT)"'

  # storage_state escape hatch (SSO/MFA/captcha): a session recorded elsewhere, no credentials needed
  cp .wingman-spec/local/auth/admin.json .wingman-spec/local/auth/preset.json
  setcfg "  roles:
    sso-admin:
      storage_state: .wingman-spec/local/auth/preset.json
"
  mkchange "$(sc 'SSO admin' $'route: /admin\nrole: sso-admin\nviewports: 1280\nkey: [data-testid="admin-panel"]')"
  rc=0; env -u WINGMAN_ROLE_ADMIN_PASSWORD -u WINGMAN_ROLE_ADMIN_USER $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "storage_state: a recorded session is used as is, without credentials" '[ $rc = 0 ] && grep -q "\"result\": \"clean\"" "$T/v.json"'
  setcfg "$ROLES"
  # login_command (your own SSO/MFA script writes the session) and headers_env (token headers from env)
  cp "$PKG/tests/fixtures/roles/sso-login.js" sso-login.js
  setcfg "  roles:
    sso-user:
      login_command: node sso-login.js
    api-client:
      headers_env: X-Wingman-Token=APP_TOKEN
"
  export APP_TOKEN='tok-9f8e7d6c5b4a'
  mkchange "$(sc 'SSO admin' $'route: /admin\nrole: sso-user\nviewports: 1280\nkey: [data-testid="admin-panel"]')"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "login_command: the script writes the session and the role is logged in" '[ $rc = 0 ] && grep -q "\"result\": \"clean\"" "$T/v.json"'
  rc=0; SSO_FAIL=1 $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: a failing login_command is reported with its exit code and last output" '[ $rc = 1 ] && grep -q "login_command exited 3" "$(REPORT)" && grep -q "SSO provider said no" "$(REPORT)"'
  mkchange "$(sc 'Token viewer' $'route: /dashboard\nrole: api-client\nviewports: 1280\nkey: [data-testid="welcome"]\nabsent: [data-testid="admin-link"]')"
  rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "headers_env: the request header comes from the env var and opens the gated page" '[ $rc = 0 ] && grep -q "\"result\": \"clean\"" "$T/v.json" && ! grep -rqF "$APP_TOKEN" .wingman-spec/runs "$T/v.json" "$T/v.err"'
  rc=0; env -u APP_TOKEN $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "fault: a missing header env var names the variable" '[ $rc = 1 ] && grep -q "APP_TOKEN" "$(REPORT)"'
  unset APP_TOKEN
  setcfg "$ROLES"
  expect "after all runs, no password is in any file of the project (ignored files included) except the local credentials file" '! grep -rIlF -e "$SEC_ADMIN" -e "$SEC_VIEWER" -e "wrong-Passw0rd-zzz" . --exclude-dir=node_modules --exclude-dir=.git | grep -q . && [ -z "$(grep -rIlF "$SEC_OPS" . --exclude-dir=node_modules --exclude-dir=.git | grep -v "local/roles.yaml")" ]'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the browser part of roles is not tested"
fi

echo
echo "roles: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
