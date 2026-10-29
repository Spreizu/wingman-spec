'use strict';
/*
 * roles.cjs - log in as different users for the visual check (visual.roles in openspec/config.yaml).
 *
 *   visual:
 *     roles:
 *       admin:
 *         login: /login                       # login page path (a form with a user and a password field)
 *         success: /dashboard                 # optional: path (starts with /) or selector that shows the login worked
 *         user_field: input[name=email]       # optional selectors; the defaults match the usual email/username/password form
 *         password_field: input[type=password]
 *         submit: button[type=submit]
 *         user_env: WINGMAN_ROLE_ADMIN_USER   # optional: env var names (these are the defaults)
 *         password_env: WINGMAN_ROLE_ADMIN_PASSWORD
 *       editor:
 *         storage_state: openspec/.local/auth/editor.json   # SSO, MFA or captcha: a Playwright storage state you recorded yourself
 *       sso-user:
 *         login_command: node scripts/sso-login.js   # your own script; it writes a Playwright storage state to $WINGMAN_ROLE_STATE_FILE
 *       api-client:
 *         headers_env: Authorization=API_TOKEN, X-Tenant=TENANT_ID   # header name = name of the env var that holds its value
 *
 * Credentials are never written to config.yaml (a user/password key there is rejected). They come from the env vars above or
 * from the gitignored openspec/.local/roles.yaml (`admin:` / `  user: ...` / `  password: ...`). The session of a login is saved
 * to openspec/.local/auth/<role>.json (the folder ignores itself, mode 600) and reused by the scenarios of that run. Passwords are never printed;
 * error text is scrubbed of them; a failed login leaves a screenshot in the system temp dir (never in the repository).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = ['login', 'success', 'user_field', 'password_field', 'submit', 'user_env', 'password_env', 'storage_state', 'login_command', 'headers_env'];
const SECRET_FIELDS = /^(user|username|email|password|pass|passwd|token|secret|cookie|cookies|api_key|apikey)$/;
const DEFAULT_USER_FIELD = 'input[type=email], input[name=email], input[name=username], input[name=user], input[autocomplete=username], input[type=text]';
const DEFAULT_PASSWORD_FIELD = 'input[type=password]';
const DEFAULT_SUBMIT = 'button[type=submit], input[type=submit]';
const LOCAL_DIR = 'openspec/.local'; // everything private to this checkout; the folder ignores itself, so no project .gitignore line is needed
const LOCAL_FILE = `${LOCAL_DIR}/roles.yaml`;
const AUTH_DIR = `${LOCAL_DIR}/auth`;
/** Make sure the private folder exists and ignores itself (a `*` .gitignore inside it also ignores that file). Returns its path. */
function localDir(codeRoot) {
  const dir = path.join(codeRoot, LOCAL_DIR); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gi = path.join(dir, '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return dir;
}

const envBase = (name) => `WINGMAN_ROLE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
const envNames = (name, role) => ({ user: (role && role.user_env) || `${envBase(name)}_USER`, password: (role && role.password_env) || `${envBase(name)}_PASSWORD` });

/**
 * Parses the `roles:` block of the visual section. `lines[at]` is the `roles:` line (indent `parent`).
 * Returns { roles, errors, next } where next is the index of the first line after the block.
 */
function parseRolesBlock(lines, at, parent, unq) {
  const roles = {}; const errors = []; let i = at + 1; let roleIndent = null; let cur = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const indent = l.match(/^\s*/)[0].length;
    if (indent <= parent) break;
    const m = l.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { errors.push(`visual.roles: cannot read "${l.trim().slice(0, 40)}"`); continue; }
    if (roleIndent === null) roleIndent = indent;
    if (indent === roleIndent) {
      if (!ROLE_NAME.test(m[1])) { errors.push(`visual.roles: role name "${m[1]}" must be kebab-case (a-z, 0-9, -)`); cur = null; continue; }
      if (m[1] === 'anonymous') { errors.push('visual.roles: "anonymous" is built in (no login); pick another name'); cur = null; continue; }
      cur = roles[m[1]] = {}; cur.name = m[1];
      continue;
    }
    if (!cur) continue;
    const k = m[1]; const v = unq(m[2]);
    if (SECRET_FIELDS.test(k)) { errors.push(`visual.roles.${cur.name}.${k}: credentials must not be written in openspec/config.yaml; use the env vars ${Object.values(envNames(cur.name, cur)).join(' and ')}, or ${LOCAL_FILE} (gitignored)`); continue; }
    if (!FIELDS.includes(k)) { errors.push(`visual.roles.${cur.name}.${k}: unknown field (${FIELDS.join(', ')})`); continue; }
    cur[k] = v;
  }
  for (const r of Object.values(roles)) if (!r.login && !r.storage_state && !r.login_command && !r.headers_env) errors.push(`visual.roles.${r.name}: needs one of \`login:\` (the login page path), \`storage_state:\` (a recorded Playwright session file), \`login_command:\` (a script that writes one) or \`headers_env:\` (request headers from env vars)`);
  for (const r of Object.values(roles)) if (r.headers_env && parseHeaders(r.headers_env).error) errors.push(`visual.roles.${r.name}.headers_env: ${parseHeaders(r.headers_env).error}`);
  for (const r of Object.values(roles)) if (r.login && !String(r.login).startsWith('/')) errors.push(`visual.roles.${r.name}.login: must be a path starting with "/", got "${r.login}"`);
  return { roles, errors, next: i - 1 };
}

/** `Name=ENV_VAR, Name2=ENV_VAR2` -> [{ name, env }]. The header values live in the environment, never in the config. */
function parseHeaders(v) {
  const list = []; for (const part of String(v).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9-]+)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!m) return { error: `expected "Header-Name=ENV_VAR", got "${part.replace(/=.*/, '=...')}"` };
    list.push({ name: m[1], env: m[2] });
  }
  return { list };
}

/** The gitignored local credentials file: `<role>:` then indented `user:` and `password:`. Values are never logged. */
function readLocalSecrets(codeRoot) {
  const f = path.join(codeRoot, LOCAL_FILE); const out = {};
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return out; }
  localDir(codeRoot); // a hand-made credentials file in a fresh clone is ignored from the first read on
  let cur = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const m = raw.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*?)\s*$/); if (!m) continue;
    if (!m[1].length) { cur = out[m[2]] = {}; continue; }
    if (cur && (m[2] === 'user' || m[2] === 'password')) cur[m[2]] = m[3].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Where the credentials of a role come from. Never returns more than names: `value` is for the login only. */
function credentials(name, role, codeRoot, env = process.env) {
  if (role.storage_state) return { via: 'storage_state', missing: [] };
  if (role.login_command) return { via: 'login_command', missing: [] };
  if (!role.login && role.headers_env) return { via: 'headers', missing: [] };
  const names = envNames(name, role); const local = readLocalSecrets(codeRoot)[name] || {};
  const user = env[names.user] || local.user; const password = env[names.password] || local.password;
  const missing = [];
  if (!user) missing.push(names.user); if (!password) missing.push(names.password);
  const src = (env[names.user] && env[names.password]) ? 'env' : (local.user && local.password && !env[names.user] && !env[names.password]) ? 'local-file' : (missing.length ? null : 'env+local-file');
  return { via: 'login', user, password, source: src, missing, names };
}

/** For `doctor`: what every role needs and whether it has it. No values. */
function describe(roles, codeRoot, env = process.env) {
  return Object.values(roles || {}).map((r) => {
    const c = credentials(r.name, r, codeRoot, env);
    if (c.via === 'storage_state') { const f = path.resolve(codeRoot, r.storage_state); return { role: r.name, via: 'storage_state', file: r.storage_state, ready: fs.existsSync(f), missing: fs.existsSync(f) ? [] : [`file ${r.storage_state}`] }; }
    if (c.via === 'login_command') return { role: r.name, via: 'login_command', ready: true, missing: [] };
    if (r.headers_env) { const miss = parseHeaders(r.headers_env).list.filter((h) => !env[h.env]).map((h) => `env ${h.env}`); if (c.via === 'headers' || miss.length) return { role: r.name, via: c.via === 'headers' ? 'headers' : 'login+headers', ready: !miss.length, missing: miss }; }
    return { role: r.name, via: 'login', login: r.login, ready: !c.missing.length, source: c.source, missing: c.missing.map((n) => `env ${n} (or ${LOCAL_FILE})`) };
  });
}

const scrub = (text, secrets) => secrets.filter((s) => s && String(s).length >= 3).reduce((t, s) => String(t).split(String(s)).join('***'), String(text));
const firstLine = (e) => String(e && e.message || e).split('\n')[0];

/**
 * Logs in as `name` in a fresh browser context and returns { ok, via, state } or { ok:false, code, error, shot? }.
 * o: { base: URL, codeRoot, ignoreHttps, timeoutMs, env }
 */
async function login(browser, name, role, o) {
  const env = o.env || process.env;
  const c = credentials(name, role, o.codeRoot, env);
  const hdr = role.headers_env ? parseHeaders(role.headers_env).list : [];
  const missingH = hdr.filter((h) => !env[h.env]).map((h) => h.env);
  if (missingH.length) return { ok: false, code: 'role:no-credentials', error: `role ${name}: set the env var${missingH.length > 1 ? 's' : ''} ${missingH.join(', ')} (header values come from the environment). Nothing gated by this role was verified.` };
  const headers = Object.fromEntries(hdr.map((h) => [h.name, env[h.env]]));
  const hsecrets = Object.values(headers);
  if (c.via === 'headers') return { ok: true, via: 'headers', state: undefined, headers };
  if (c.via === 'login_command') {
    localDir(o.codeRoot); const dir = path.join(o.codeRoot, AUTH_DIR); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `${name}.json`); try { fs.rmSync(f, { force: true }); } catch (e) { /* none */ }
    const r = require('child_process').spawnSync(role.login_command, { shell: true, cwd: o.codeRoot, encoding: 'utf8', timeout: (o.timeoutMs || 15000) * 4, env: { ...env, WINGMAN_ROLE: name, WINGMAN_ROLE_STATE_FILE: f, WINGMAN_BASE_URL: o.base.href } });
    const tail = scrub(String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300), hsecrets);
    if (r.error || r.status !== 0) return { ok: false, code: 'role:login-failed', error: `role ${name}: login_command exited ${r.status === null ? 'abnormally' : r.status}${tail ? `; last output: ${tail}` : ''}` };
    if (!fs.existsSync(f)) return { ok: false, code: 'role:no-storage-state', error: `role ${name}: login_command finished but wrote no storage state to $WINGMAN_ROLE_STATE_FILE (${path.join(AUTH_DIR, name + '.json')})` };
    try { return { ok: true, via: 'login_command', state: JSON.parse(fs.readFileSync(f, 'utf8')), headers }; } catch (e) { return { ok: false, code: 'role:no-storage-state', error: `role ${name}: the file login_command wrote is not valid JSON` }; }
  }
  if (c.via === 'storage_state') {
    const f = path.resolve(o.codeRoot, role.storage_state);
    if (!fs.existsSync(f)) return { ok: false, code: 'role:no-storage-state', error: `role ${name}: storage_state file ${role.storage_state} does not exist; record one (npx playwright codegen --save-storage=${role.storage_state} <url>), it is gitignored` };
    try { return { ok: true, via: 'storage_state', state: JSON.parse(fs.readFileSync(f, 'utf8')), headers }; } catch (e) { return { ok: false, code: 'role:no-storage-state', error: `role ${name}: ${role.storage_state} is not valid JSON` }; }
  }
  if (c.missing.length) return { ok: false, code: 'role:no-credentials', error: `role ${name}: no credentials; set the env vars ${c.names.user} and ${c.names.password}, or add \`${name}:\` with \`user:\` and \`password:\` to ${LOCAL_FILE} (gitignored). Nothing gated by this role was verified.` };
  const secrets = [c.user, c.password, ...hsecrets]; const timeout = o.timeoutMs || 15000;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: o.ignoreHttps !== false, ...(hdr.length ? { extraHTTPHeaders: headers } : {}) });
  ctx.setDefaultTimeout(timeout);
  const page = await ctx.newPage();
  try {
    const loginUrl = new URL(role.login, o.base);
    await page.goto(loginUrl.href, { waitUntil: 'load' });
    await page.locator(role.user_field || DEFAULT_USER_FIELD).first().fill(c.user);
    const pw = page.locator(role.password_field || DEFAULT_PASSWORD_FIELD).first();
    await pw.fill(c.password);
    if (role.submit) await page.locator(role.submit).first().click();
    else if (await page.locator(DEFAULT_SUBMIT).count()) await page.locator(DEFAULT_SUBMIT).first().click();
    else await pw.press('Enter');
    if (role.success && role.success.startsWith('/')) await page.waitForURL((u) => u.pathname === role.success, { timeout });
    else if (role.success) await page.waitForSelector(role.success, { state: 'visible', timeout });
    else await page.waitForURL((u) => u.pathname !== loginUrl.pathname, { timeout });
    await page.waitForLoadState('load').catch(() => {});
    const state = await ctx.storageState();
    localDir(o.codeRoot); const dir = path.join(o.codeRoot, AUTH_DIR); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(state), { mode: 0o600 }); fs.chmodSync(f, 0o600);
    await ctx.close();
    return { ok: true, via: 'login', state, headers, file: path.join(AUTH_DIR, `${name}.json`) };
  } catch (e) {
    let shot = null; let alert = '';
    try { alert = String(await page.locator('[role=alert], .error, .alert').first().innerText({ timeout: 500 })).replace(/\s+/g, ' ').slice(0, 120); } catch (x) { /* none */ }
    try { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-login-')); shot = path.join(dir, `${name}.png`); await page.screenshot({ path: shot }); } catch (x) { shot = null; }
    await ctx.close().catch(() => {});
    return { ok: false, code: 'role:login-failed', error: scrub(`role ${name}: login at ${role.login} failed: ${firstLine(e)}${alert ? `; the page says "${alert}"` : ''}${shot ? `; screenshot (temporary, not in the repository): ${shot}` : ''}`, secrets) };
  }
}

module.exports = { ROLE_NAME, LOCAL_FILE, AUTH_DIR, parseRolesBlock, describe, login };
