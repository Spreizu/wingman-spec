// Unit checks of anchorfit.cjs (run by tests/anchorfit.sh): prints "  ok   <name>" / "  FAIL <name>" lines.
const path = require('path');
const F = require(path.join(process.argv[2], 'anchorfit.cjs'));
let fails = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };
const reqs = new Map([
  ['auth/user-login', { name: 'User login', block: 'The system SHALL let a registered user log in with email and password and reject a wrong password.', cap: 'auth' }],
  ['auth/password-reset', { name: 'Password reset', block: 'The system SHALL send a reset link to the registered email address.', cap: 'auth' }],
  ['checkout/order-summary', { name: 'Order summary', block: 'The system SHALL show the order total with tax before payment.', cap: 'checkout' }],
]);
const caps = new Set(['auth', 'checkout']);
const fit = (files, extra = {}) => F.fitFindings({ files, reqs, capNames: caps, ...extra });
const kinds = (r) => r.map((x) => x.kind).sort().join(',');
const src = (file, text) => ({ file, text, test: false });
const LOGIN = '/**\n * @spec auth/user-login\n */\nexport function login(email: string, password: string) {\n  const user = findUser(email);\n  if (!user || !verify(password, user.hash)) throw new Error("wrong password");\n  return session(user);\n}\n';

console.log('== the reported case: a login requirement anchored on a string line of another feature');
const I18N = "export const messages = {\n  'cart.title': 'Your cart',\n  // @spec auth/user-login\n  'login.error': 'Wrong email or password',\n  'cart.total': 'Total',\n};\n";
let r = fit([src('src/checkout/lang/en.ts', I18N), src('src/auth/login.ts', LOGIN)]);
t('the string-table anchor is flagged boilerplate-anchor', kinds(r) === 'boilerplate-anchor' && r[0].file === 'src/checkout/lang/en.ts' && r[0].line === 3);
t('the finding is removable (login.ts still carries the requirement)', r[0].remove === true);
t('the login function itself is not flagged', !r.some((x) => x.file === 'src/auth/login.ts'));
r = fit([src('src/checkout/lang/en.ts', I18N)]);
t('as the only anchor it is flagged but not removable (move it)', kinds(r) === 'boilerplate-anchor' && r[0].remove === false && /last anchor/.test(r[0].text));
r = fit([src('resources/lang/en.yml', 'cart_title: Your cart\n# @spec auth/user-login\nlogin_error: Wrong email or password\n'), src('src/auth/login.ts', LOGIN)]);
t('a YAML locale file is a string table too', kinds(r) === 'boilerplate-anchor');
r = fit([src('src/checkout/summary.ts', '/**\n * @spec auth/user-login\n */\nexport function orderSummary(order: Order) {\n  return order.lines.reduce((s, l) => s + l.price, 0) * 1.2;\n}\n'), src('src/auth/login.ts', LOGIN)]);
t('a login marker on the checkout summary function is a foreign-anchor (file of another capability)', kinds(r) === 'foreign-anchor');

console.log('== boilerplate units (each language) are flagged, deciding units are not');
const one = (file, text) => kinds(fit([src(file, text), src('src/auth/login.ts', LOGIN)]));
t('ts import', one('src/auth/session.ts', '// @spec auth/user-login\nimport { db } from "./db";\n') === 'boilerplate-anchor');
t('ts constant', one('src/auth/session.ts', '// @spec auth/user-login\nexport const MAX_TRIES = 5;\n') === 'boilerplate-anchor');
t('ts type', one('src/auth/session.ts', '// @spec auth/user-login\nexport interface Credentials {\n  email: string;\n  password: string;\n}\n') === 'boilerplate-anchor');
t('python import', one('src/auth/session.py', '# @spec auth/user-login\nfrom db import connect\n') === 'boilerplate-anchor');
t('python constant', one('src/auth/session.py', '# @spec auth/user-login\nMAX_TRIES = 5\n') === 'boilerplate-anchor');
t('java getter', one('src/auth/User.java', 'class User {\n  /** @spec auth/user-login */\n  public String getEmail() {\n    return email;\n  }\n}\n') === 'boilerplate-anchor');
t('go log call', one('src/auth/log.go', 'func f() {\n\t// @spec auth/user-login\n\tlog.Printf("login attempt")\n}\n') === 'boilerplate-anchor');
t('php constant', one('src/auth/Session.php', '<?php\n// @spec auth/user-login\nconst MAX_TRIES = 5;\n') === 'boilerplate-anchor');
t('a constant that holds an SQL query is behaviour, not boilerplate', one('src/todos/Repo.php', "<?php\n// @spec todos/list-open\nconst OPEN_SQL = 'SELECT id, title FROM todos\nWHERE done = 0';\n") !== 'boilerplate-anchor');
t('a deciding function is not flagged', one('src/auth/session.ts', '/**\n * @spec auth/user-login\n */\nexport function rejectBadPassword(user: User, password: string) {\n  if (!verify(password, user.hash)) throw new Error("wrong password");\n}\n') === '');
t('a route registration line (wiring) is not boilerplate: it can be the entry point', one('src/auth/routes.ts', '// @spec auth/user-login\nrouter.post("/login", handleLogin);\n') === '');

console.log('== many anchors for one requirement: a count alone is no finding');
const part = (i) => src(`src/auth/part${i}.ts`, `/**\n * @spec auth/user-login\n */\nexport function checkLoginStep${i}(email: string, password: string) {\n  return verify(email, password, ${i});\n}\n`);
const parts = (n) => Array.from({ length: n }, (_, k) => part(k + 1));
const DUAL = src('src/auth/dual.ts', '/**\n * @spec auth/user-login\n */\nexport function checkLoginBoth(email: string, password: string) {\n  // @spec auth/user-login\n  return verify(email, password, 9);\n}\n');
r = fit(parts(7));
t('7 distinct good anchors (default ceiling is 6): no finding at all', r.length === 0);
r = fit(parts(7), { max: 1 });
t('anchor_max 1 with 7 distinct good anchors: still nothing (a count never flags anchors that fit)', r.length === 0);
r = fit([...parts(2), DUAL, part(3)], { max: 4 });
t('5 anchors, 2 in one function: one finding, on the second marker, listing the weak one; removable', r.length === 1 && r[0].kind === 'over-anchored' && r[0].file === 'src/auth/dual.ts' && r[0].line === 5 && r[0].remove === true && /weak: src\/auth\/dual\.ts:5/.test(r[0].text) && /5 code anchors/.test(r[0].text));
r = fit([...parts(2), DUAL, part(3)]);
t('the same 5 anchors under the default max (6): nothing, the count is not above it', r.length === 0);
r = fit([...parts(7), src('src/checkout/lang/en.ts', I18N)]);
t('8 anchors, 1 boilerplate: only that one is flagged (as boilerplate), the 7 good ones are not', r.length === 1 && r[0].kind === 'boilerplate-anchor' && r[0].file === 'src/checkout/lang/en.ts');
r = fit([...parts(2), DUAL, part(3)], { max: 4, many: new Set(['auth/user-login']) });
t('anchor_many silences the count for that requirement', r.length === 0);
const reqsMany = new Map(reqs); reqsMany.set('auth/user-login', { ...reqs.get('auth/user-login'), block: reqs.get('auth/user-login').block + '\nAnchors: many' });
r = F.fitFindings({ files: [...parts(2), DUAL, part(3)], reqs: reqsMany, capNames: caps, max: 4 });
t('`Anchors: many` in the requirement silences it too', r.length === 0);
r = fit(parts(13));
t('13 good anchors (above the ceiling of 12): one info line, not removable, no anchor flagged', r.length === 1 && r[0].kind === 'many-anchors' && r[0].info === true && r[0].remove === false && /split/.test(r[0].text));
r = fit(parts(12));
t('12 good anchors: nothing', r.length === 0);
r = F.fitFindings({ files: parts(13), reqs: reqsMany, capNames: caps });
t('`Anchors: many` silences the info line', r.length === 0);
t('the foreign and boilerplate rules still apply to every anchor, whatever the count', kinds(fit([...parts(7), src('src/checkout/summary.ts', '/**\n * @spec auth/user-login\n */\nexport function orderSummary(order: Order) {\n  return order.lines.reduce((s, l) => s + l.price, 0) * 1.2;\n}\n')])) === 'foreign-anchor');
t('test files are never judged or counted', fit([...parts(3), { file: 'tests/login.test.ts', text: '// @spec auth/user-login\nit("a", () => {});\n', test: true }]).length === 0);

console.log('== many requirements in one small unit');
const crowd = '/**\n * @spec auth/user-login\n * @spec auth/password-reset\n * @spec checkout/order-summary\n */\nexport function loginResetOrderSummarySignup(email: string, password: string, resetLink: string, order: Order, account: Account) {\n  return [email, password, resetLink, order.total, order.tax, account];\n}\n';
r = fit([src('src/app.ts', crowd)]);
t('3 requirements in one unit is fine', r.length === 0);
const crowd4 = new Map(reqs); crowd4.set('auth/signup', { name: 'Signup', block: 'The system SHALL create an account for a new user.', cap: 'auth' });
r = F.fitFindings({ files: [src('src/app.ts', crowd.replace('@spec checkout/order-summary', '@spec checkout/order-summary\n * @spec auth/signup'))], reqs: crowd4, capNames: caps });
t('4 requirements in one small unit: the least fitting one is crowded-unit', r.some((x) => x.kind === 'crowded-unit'));

console.log('== a file of a different capability, and no word of the requirement');
r = fit([src('src/checkout/pay.ts', '/**\n * @spec auth/password-reset\n */\nexport function pay(order: Order) {\n  return charge(order);\n}\n'), src('src/auth/reset.ts', '/** @spec auth/password-reset */\nexport function sendResetLink(email: string) {\n  return mail(email);\n}\n')]);
t('capability folder differs from the requirement: foreign-anchor', kinds(r) === 'foreign-anchor' && r[0].file === 'src/checkout/pay.ts');
r = fit([src('src/shared/util.ts', '/**\n * @spec auth/password-reset\n */\nexport function pay(order: Order) {\n  return charge(order);\n}\n'), src('src/auth/reset.ts', '/** @spec auth/password-reset */\nexport function sendResetLink(email: string) {\n  return mail(email);\n}\n')]);
t('no word of the requirement in the unit: unrelated-anchor', kinds(r) === 'unrelated-anchor');
r = fit([src('src/shared/util.ts', '/**\n * @spec auth/password-reset\n */\nexport function sendLink(address: string) {\n  return mail(address);\n}\n')]);
t('a shared helper with words of the requirement is fine', r.length === 0);
r = fit([src('src/shared/util.ts', '/**\n * @spec auth/password-reset\n */\nexport function pay(order: Order) {\n  return charge(order);\n}\n')], { taskCaps: new Map([['src/shared/util.ts', new Set(['checkout'])]]) });
t('a task Files entry of another capability makes the file foreign', kinds(r) === 'foreign-anchor');
t('an unknown requirement key is left to the unresolved-marker check', fit([src('src/x.ts', '// @spec nope/none\nexport function f() {\n  return 1;\n}\n')]).length === 0);

console.log('== removeMarkers touches only marker text');
const rm = (text, line, key) => F.removeMarkers({ f: text }, [{ file: 'f', line, key }]).f;
t('a comment line holding only the marker goes whole', rm('// @spec a/b\ncode();\n', 1, 'a/b') === 'code();\n');
t('a marker line inside a doc block goes, the block stays', rm('/**\n * Does it.\n * @spec a/b\n */\nfunction f() {}\n', 3, 'a/b') === '/**\n * Does it.\n */\nfunction f() {}\n');
t('a one-line doc comment goes whole', rm('/** @spec a/b */\nfunction f() {}\n', 1, 'a/b') === 'function f() {}\n');
t('one key of several loses just that key', rm('// @spec a/b, a/c\nf();\n', 1, 'a/b') === '// @spec a/c\nf();\n' && rm('// @spec a/b, a/c, a/d\nf();\n', 1, 'a/c') === '// @spec a/b, a/d\nf();\n');
t('a key that is a prefix of another is not confused with it', rm('// @spec a/b\n// @spec a/bc\n', 1, 'a/b') === '// @spec a/bc\n');
t('a marker with words after it keeps the words', rm('// @spec a/b: login flow\nf();\n', 1, 'a/b') === '// login flow\nf();\n');
t('an end-of-line marker leaves the code', rm('x = 1  // @spec a/b\n', 1, 'a/b') === 'x = 1\n');
t('CRLF is kept', rm('# @spec a/b\r\ndef f(): pass\r\n', 1, 'a/b') === 'def f(): pass\r\n');
t('an HTML comment goes whole', rm('<!-- @spec a/b -->\n<div/>\n', 1, 'a/b') === '<div/>\n');
t('a wrong line number changes nothing', rm('// @spec a/b\n', 5, 'a/b') === '// @spec a/b\n');

console.log('== translation files of other ecosystems: the path alone says string table (even with no code of the marker\'s own)');
const login2 = src('src/auth/login.ts', LOGIN);
const tr = (file, text) => kinds(fit([src(file, text), login2]));
const M = '@spec auth/user-login';
const PHPARR = `<?php\n// ${M}\n$lang['login_error'] = 'Wrong email or password';\n`;
t('a language/en/site.php array file', tr('src/language/en/site.php', PHPARR) === 'boilerplate-anchor');
t('resources/lang/en/auth.php', tr('resources/lang/en/auth.php', `<?php\n// ${M}\nreturn ['failed' => 'Wrong email or password'];\n`) === 'boilerplate-anchor');
t('translations/messages.fr.yaml', tr('translations/messages.fr.yaml', `# ${M}\nlogin.error: Mauvais mot de passe\n`) === 'boilerplate-anchor');
t('messages.fr.yml next to the code', tr('src/Resources/messages.fr.yml', `# ${M}\nlogin.error: Mauvais mot de passe\n`) === 'boilerplate-anchor');
t('config/locales/en.yml', tr('config/locales/en.yml', `en:\n  # ${M}\n  login_error: Wrong email or password\n`) === 'boilerplate-anchor');
t('locale/de/LC_MESSAGES/django.po', tr('locale/de/LC_MESSAGES/django.po', `# ${M}\nmsgid "Wrong password"\nmsgstr "Falsches Passwort"\n`) === 'boilerplate-anchor');
t('gettext .pot', tr('po/app.pot', `# ${M}\nmsgid "Wrong password"\nmsgstr ""\n`) === 'boilerplate-anchor');
t('Android res/values-de/strings.xml', tr('app/src/main/res/values-de/strings.xml', `<resources>\n  <!-- ${M} -->\n  <string name="login_error">Falsch</string>\n</resources>\n`) === 'boilerplate-anchor');
t('iOS de.lproj/Localizable.strings', tr('App/de.lproj/Localizable.strings', `/* ${M} */\n"login_error" = "Falsch";\n`) === 'boilerplate-anchor');
t('Java messages_de_DE.properties', tr('src/main/resources/messages_de_DE.properties', `# ${M}\nlogin.error=Falsch\n`) === 'boilerplate-anchor');
t('public/locales/de.yaml', tr('public/locales/de.yaml', `# ${M}\nlogin_error: Falsch\n`) === 'boilerplate-anchor');
t('Flutter .arb', tr('lib/l10n/app_de.arb', `{\n  "loginError": "Falsch"\n}\n// ${M}\n`) === 'boilerplate-anchor');
t('.NET Strings.de.resx', tr('Resources/Strings.de.resx', `<root>\n<!-- ${M} -->\n<data name="LoginError"><value>Falsch</value></data>\n</root>\n`) === 'boilerplate-anchor');
t('i18n/de.json with an anchor line comment style', tr('src/i18n/de.yaml', `# ${M}\nlogin_error: Falsch\n`) === 'boilerplate-anchor');

console.log('== a directory or file that merely sounds like a translation is not one');
const LOGIC = `// ${M}\nexport function pickLanguage(user: User, accept: string) {\n  if (!user) return accept.split(",")[0];\n  return user.language || "en";\n}\n`;
t('languages.ts (a util with logic) is not a translation table', !tr('src/util/languages.ts', LOGIC).includes('boilerplate'));
t('src/languages/index.ts with logic (weak directory, content decides) is not flagged', !tr('src/languages/index.ts', LOGIC).includes('boilerplate'));
t('src/languages/en.ts with only entries is flagged by its content', tr('src/languages/en.ts', `export default {\n  // ${M}\n  'login.error': 'Wrong',\n  'cart.title': 'Cart',\n};\n`) === 'boilerplate-anchor');
t('a PHP class in a language directory is code', !tr('src/language/LanguageDetector.php', `<?php\nclass LanguageDetector {\n  // ${M}\n  public function detect($user) {\n    if (!$user) { return 'en'; }\n    return $user->language;\n  }\n}\n`).includes('boilerplate'));
t('application.properties is configuration, not a translation', kinds(fit([src('src/main/resources/application.properties', `# ${M}\nserver.port=8080\n`), login2])) === 'boilerplate-anchor');
t('a controller in a messages/ folder with logic is not a string table', !tr('app/messages/Notifier.php', `<?php\nclass Notifier {\n  // ${M}\n  public function send($u) {\n    if (!$u->active) { return false; }\n    return mail($u->email, 'x', 'y');\n  }\n}\n`).includes('boilerplate'));

console.log('== stacked markers: a marker with no code of its own shares the unit of the next one');
const MR = new Map([
  ['acct/login', { name: 'Sign in with a password', block: 'The system SHALL let a registered person sign in with an email and a password.', cap: 'acct' }],
  ['acct/session', { name: 'Session needs a signed-in person', block: 'The system SHALL send a person who is not signed in to the sign-in page.', cap: 'acct' }],
  ['acct/lockout', { name: 'Lock out after repeated failures', block: 'The system SHALL lock a sign-in after five failed passwords.', cap: 'acct' }],
]);
const mfit = (text) => F.fitFindings({ files: [src('app/Guard.php', text)], reqs: MR, capNames: new Set(['acct']) });
r = mfit('<?php\nfunction handle() {\n// @spec acct/login\n// @spec acct/session\nif (!signedIn()) { return redirectToSignIn(); }\n}\n');
t('two stacked markers: the first is not reported as unrelated-anchor', !r.some((x) => x.kind === 'unrelated-anchor'));
r = mfit('<?php\nfunction handle() {\n// @spec acct/login\n// @spec acct/session\n// @spec acct/lockout\nif (!signedIn()) { return redirectToSignIn(); }\n}\n');
t('three stacked markers: none is reported as unrelated-anchor', !r.some((x) => x.kind === 'unrelated-anchor'), JSON.stringify(r));
r = mfit('<?php\nfunction handle() {\n// @spec acct/login\n\n\n\n\n// @spec acct/session\nif (!signedIn()) { return redirectToSignIn(); }\n}\n');
t('markers more than 3 lines apart do not share (control)', !r.some((x) => x.kind === 'unrelated-anchor' && x.key === 'acct/session'));
r = F.fitFindings({ files: [src('src/language/en/site.php', '<?php\n// @spec auth/user-login\n// @spec auth/password-reset\n$lang["x"] = "y";\n')], reqs, capNames: caps });
t('stacked markers in a translation file: the path rule flags both', r.filter((x) => x.kind === 'boilerplate-anchor').length === 2);
r = F.fitFindings({ files: [src('src/language/en/site.php', '<?php\n// @spec auth/user-login\n')], reqs, capNames: caps });
t('a marker with no code at all in a translation file is flagged by the path alone', r.some((x) => x.kind === 'boilerplate-anchor'));

console.log('== config');
const cfg = (txt, env) => { const old = process.env.SPEC_ANCHOR_FIT; if (env === undefined) delete process.env.SPEC_ANCHOR_FIT; else process.env.SPEC_ANCHOR_FIT = env; const x = F.fitConfig(['c'], () => txt); if (old === undefined) delete process.env.SPEC_ANCHOR_FIT; else process.env.SPEC_ANCHOR_FIT = old; return x; };
t('default: warn, 6, no override', JSON.stringify(cfg('')) === '{"level":"warn","max":6,"many":{}}' && cfg('').many.size === 0);
t('anchor_fit: error, anchor_max: 2', cfg('anchor_fit: error\nanchor_max: 2\n').max === 2 && cfg('anchor_fit: error\nanchor_max: 2\n').level === 'error');
t('anchor_many: [a/b, "c/d"] is read as a set of requirement keys', [...cfg('anchor_many: [auth/user-login, "auth/password-reset"]\n').many].join() === 'auth/user-login,auth/password-reset');
t('anchor_fit: off', cfg('anchor_fit: off\n').level === 'off');
t('the env var beats the file', cfg('anchor_fit: off\n', 'error').level === 'error');
process.exit(fails ? 1 : 0);
