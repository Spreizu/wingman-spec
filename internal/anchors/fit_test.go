package anchors

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"
)

// The anchor-fit rules on seeded code (ported from the v1 unit checks of tests/anchorfit.sh).

var fitReqs = map[string]FitReq{
	"auth/user-login":        {Name: "User login", Block: "The system SHALL let a registered user log in with email and password and reject a wrong password.", Cap: "auth"},
	"auth/password-reset":    {Name: "Password reset", Block: "The system SHALL send a reset link to the registered email address.", Cap: "auth"},
	"checkout/order-summary": {Name: "Order summary", Block: "The system SHALL show the order total with tax before payment.", Cap: "checkout"},
}

var fitCaps = map[string]bool{"auth": true, "checkout": true}

const (
	fitLogin = "/**\n * @spec auth/user-login\n */\nexport function login(email: string, password: string) {\n  const user = findUser(email);\n  if (!user || !verify(password, user.hash)) throw new Error(\"wrong password\");\n  return session(user);\n}\n"
	fitI18N  = "export const messages = {\n  'cart.title': 'Your cart',\n  // @spec auth/user-login\n  'login.error': 'Wrong email or password',\n  'cart.total': 'Total',\n};\n"
	fitM     = "@spec auth/user-login"
)

func src(file, text string) FitFile { return FitFile{File: file, Text: text} }

func fit(files []FitFile, o FitOpts) []FitFinding {
	o.Files = files
	if o.Reqs == nil {
		o.Reqs = fitReqs
	}
	if o.CapNames == nil {
		o.CapNames = fitCaps
	}
	return FitFindings(o)
}

func kinds(r []FitFinding) string {
	var k []string
	for _, f := range r {
		k = append(k, f.Kind)
	}
	slices.Sort(k)
	return strings.Join(k, ",")
}

func check(t *testing.T, name string, ok bool, r ...[]FitFinding) {
	t.Helper()
	if !ok {
		t.Errorf("%s: %+v", name, r)
	}
}

func part(i int) FitFile {
	return src(fmt.Sprintf("src/auth/part%d.ts", i), fmt.Sprintf("/**\n * @spec auth/user-login\n */\nexport function checkLoginStep%d(email: string, password: string) {\n  return verify(email, password, %d);\n}\n", i, i))
}

func parts(n int) []FitFile {
	var out []FitFile
	for k := 1; k <= n; k++ {
		out = append(out, part(k))
	}
	return out
}

func TestFitReportedCase(t *testing.T) {
	r := fit([]FitFile{src("src/checkout/lang/en.ts", fitI18N), src("src/auth/login.ts", fitLogin)}, FitOpts{})
	check(t, "the string-table anchor is flagged boilerplate-anchor", kinds(r) == "boilerplate-anchor" && r[0].File == "src/checkout/lang/en.ts" && r[0].Line == 3, r)
	check(t, "the finding is removable (login.ts still carries the requirement)", len(r) > 0 && r[0].Remove, r)
	check(t, "the login function itself is not flagged", !slices.ContainsFunc(r, func(f FitFinding) bool { return f.File == "src/auth/login.ts" }), r)
	r = fit([]FitFile{src("src/checkout/lang/en.ts", fitI18N)}, FitOpts{})
	check(t, "as the only anchor it is flagged but not removable (move it)", kinds(r) == "boilerplate-anchor" && !r[0].Remove && strings.Contains(r[0].Text, "last anchor"), r)
	r = fit([]FitFile{src("resources/lang/en.yml", "cart_title: Your cart\n# @spec auth/user-login\nlogin_error: Wrong email or password\n"), src("src/auth/login.ts", fitLogin)}, FitOpts{})
	check(t, "a YAML locale file is a string table too", kinds(r) == "boilerplate-anchor", r)
	r = fit([]FitFile{src("src/checkout/summary.ts", "/**\n * @spec auth/user-login\n */\nexport function orderSummary(order: Order) {\n  return order.lines.reduce((s, l) => s + l.price, 0) * 1.2;\n}\n"), src("src/auth/login.ts", fitLogin)}, FitOpts{})
	check(t, "a login marker on the checkout summary function is a foreign-anchor", kinds(r) == "foreign-anchor", r)
}

func TestFitBoilerplate(t *testing.T) {
	one := func(file, text string) string {
		return kinds(fit([]FitFile{src(file, text), src("src/auth/login.ts", fitLogin)}, FitOpts{}))
	}
	for name, c := range map[string]struct{ file, text, want string }{
		"ts import":                          {"src/auth/session.ts", "// @spec auth/user-login\nimport { db } from \"./db\";\n", "boilerplate-anchor"},
		"ts constant":                        {"src/auth/session.ts", "// @spec auth/user-login\nexport const MAX_TRIES = 5;\n", "boilerplate-anchor"},
		"ts type":                            {"src/auth/session.ts", "// @spec auth/user-login\nexport interface Credentials {\n  email: string;\n  password: string;\n}\n", "boilerplate-anchor"},
		"python import":                      {"src/auth/session.py", "# @spec auth/user-login\nfrom db import connect\n", "boilerplate-anchor"},
		"python constant":                    {"src/auth/session.py", "# @spec auth/user-login\nMAX_TRIES = 5\n", "boilerplate-anchor"},
		"java getter":                        {"src/auth/User.java", "class User {\n  /** @spec auth/user-login */\n  public String getEmail() {\n    return email;\n  }\n}\n", "boilerplate-anchor"},
		"go log call":                        {"src/auth/log.go", "func f() {\n\t// @spec auth/user-login\n\tlog.Printf(\"login attempt\")\n}\n", "boilerplate-anchor"},
		"php constant":                       {"src/auth/Session.php", "<?php\n// @spec auth/user-login\nconst MAX_TRIES = 5;\n", "boilerplate-anchor"},
		"a deciding function is not flagged": {"src/auth/session.ts", "/**\n * @spec auth/user-login\n */\nexport function rejectBadPassword(user: User, password: string) {\n  if (!verify(password, user.hash)) throw new Error(\"wrong password\");\n}\n", ""},
		"a route registration line (wiring) is not boilerplate": {"src/auth/routes.ts", "// @spec auth/user-login\nrouter.post(\"/login\", handleLogin);\n", ""},
	} {
		if got := one(c.file, c.text); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
	if got := one("src/todos/Repo.php", "<?php\n// @spec todos/list-open\nconst OPEN_SQL = 'SELECT id, title FROM todos\nWHERE done = 0';\n"); got == "boilerplate-anchor" {
		t.Error("a constant that holds an SQL query is behaviour, not boilerplate")
	}
}

func TestFitCount(t *testing.T) {
	dual := src("src/auth/dual.ts", "/**\n * @spec auth/user-login\n */\nexport function checkLoginBoth(email: string, password: string) {\n  // @spec auth/user-login\n  return verify(email, password, 9);\n}\n")
	five := append(append(parts(2), dual), part(3))
	r := fit(parts(7), FitOpts{})
	check(t, "7 distinct good anchors (default ceiling 6): no finding", len(r) == 0, r)
	r = fit(parts(7), FitOpts{Max: 1})
	check(t, "anchor_max 1 with 7 good anchors: still nothing", len(r) == 0, r)
	r = fit(five, FitOpts{Max: 4})
	check(t, "5 anchors, 2 in one function: one finding on the second marker, removable",
		len(r) == 1 && r[0].Kind == "over-anchored" && r[0].File == "src/auth/dual.ts" && r[0].Line == 5 && r[0].Remove &&
			strings.Contains(r[0].Text, "weak: src/auth/dual.ts:5") && strings.Contains(r[0].Text, "5 code anchors"), r)
	r = fit(five, FitOpts{})
	check(t, "the same 5 anchors under the default max: nothing", len(r) == 0, r)
	r = fit(append(parts(7), src("src/checkout/lang/en.ts", fitI18N)), FitOpts{})
	check(t, "8 anchors, 1 boilerplate: only that one is flagged", len(r) == 1 && r[0].Kind == "boilerplate-anchor" && r[0].File == "src/checkout/lang/en.ts", r)
	r = fit(five, FitOpts{Max: 4, Many: map[string]bool{"auth/user-login": true}})
	check(t, "anchor_many silences the count", len(r) == 0, r)
	many := map[string]FitReq{}
	maps.Copy(many, fitReqs)
	lr := many["auth/user-login"]
	lr.Block += "\nAnchors: many"
	many["auth/user-login"] = lr
	r = fit(five, FitOpts{Max: 4, Reqs: many})
	check(t, "`Anchors: many` in the requirement silences it too", len(r) == 0, r)
	r = fit(parts(13), FitOpts{})
	check(t, "13 good anchors: one info line, not removable", len(r) == 1 && r[0].Kind == "many-anchors" && r[0].Info && !r[0].Remove && strings.Contains(r[0].Text, "split"), r)
	r = fit(parts(12), FitOpts{})
	check(t, "12 good anchors: nothing", len(r) == 0, r)
	r = fit(parts(13), FitOpts{Reqs: many})
	check(t, "`Anchors: many` silences the info line", len(r) == 0, r)
	r = fit(append(parts(7), src("src/checkout/summary.ts", "/**\n * @spec auth/user-login\n */\nexport function orderSummary(order: Order) {\n  return order.lines.reduce((s, l) => s + l.price, 0) * 1.2;\n}\n")), FitOpts{})
	check(t, "the foreign rule applies whatever the count", kinds(r) == "foreign-anchor", r)
	r = fit(append(parts(3), FitFile{File: "tests/login.test.ts", Text: "// @spec auth/user-login\nit(\"a\", () => {});\n", Test: true}), FitOpts{})
	check(t, "test files are never judged or counted", len(r) == 0, r)
}

func TestFitCrowdedUnit(t *testing.T) {
	crowd := "/**\n * @spec auth/user-login\n * @spec auth/password-reset\n * @spec checkout/order-summary\n */\nexport function loginResetOrderSummarySignup(email: string, password: string, resetLink: string, order: Order, account: Account) {\n  return [email, password, resetLink, order.total, order.tax, account];\n}\n"
	r := fit([]FitFile{src("src/app.ts", crowd)}, FitOpts{})
	check(t, "3 requirements in one unit is fine", len(r) == 0, r)
	four := map[string]FitReq{"auth/signup": {Name: "Signup", Block: "The system SHALL create an account for a new user.", Cap: "auth"}}
	maps.Copy(four, fitReqs)
	r = fit([]FitFile{src("src/app.ts", strings.Replace(crowd, "@spec checkout/order-summary", "@spec checkout/order-summary\n * @spec auth/signup", 1))}, FitOpts{Reqs: four})
	check(t, "4 requirements in one small unit: crowded-unit", slices.ContainsFunc(r, func(f FitFinding) bool { return f.Kind == "crowded-unit" }), r)
}

func TestFitForeignAndUnrelated(t *testing.T) {
	reset := src("src/auth/reset.ts", "/** @spec auth/password-reset */\nexport function sendResetLink(email: string) {\n  return mail(email);\n}\n")
	pay := "/**\n * @spec auth/password-reset\n */\nexport function pay(order: Order) {\n  return charge(order);\n}\n"
	r := fit([]FitFile{src("src/checkout/pay.ts", pay), reset}, FitOpts{})
	check(t, "capability folder differs: foreign-anchor", kinds(r) == "foreign-anchor" && r[0].File == "src/checkout/pay.ts", r)
	r = fit([]FitFile{src("src/shared/util.ts", pay), reset}, FitOpts{})
	check(t, "no word of the requirement: unrelated-anchor", kinds(r) == "unrelated-anchor", r)
	r = fit([]FitFile{src("src/shared/util.ts", "/**\n * @spec auth/password-reset\n */\nexport function sendLink(address: string) {\n  return mail(address);\n}\n")}, FitOpts{})
	check(t, "a shared helper with words of the requirement is fine", len(r) == 0, r)
	r = fit([]FitFile{src("src/shared/util.ts", pay)}, FitOpts{TaskCaps: map[string]map[string]bool{"src/shared/util.ts": {"checkout": true}}})
	check(t, "a task Files entry of another capability makes the file foreign", kinds(r) == "foreign-anchor", r)
	r = fit([]FitFile{src("src/x.ts", "// @spec nope/none\nexport function f() {\n  return 1;\n}\n")}, FitOpts{})
	check(t, "an unknown requirement key is left to the unresolved-marker check", len(r) == 0, r)
}

func TestRemoveMarkers(t *testing.T) {
	rm := func(text string, line int, key string) string {
		out := RemoveMarkers(map[string]string{"f": text}, []RemovePick{{File: "f", Line: line, Key: key}})
		if s, ok := out["f"]; ok {
			return s
		}
		return text
	}
	for _, c := range []struct {
		name, in  string
		line      int
		key, want string
	}{
		{"a comment line holding only the marker goes whole", "// @spec a/b\ncode();\n", 1, "a/b", "code();\n"},
		{"a marker line inside a doc block goes, the block stays", "/**\n * Does it.\n * @spec a/b\n */\nfunction f() {}\n", 3, "a/b", "/**\n * Does it.\n */\nfunction f() {}\n"},
		{"a one-line doc comment goes whole", "/** @spec a/b */\nfunction f() {}\n", 1, "a/b", "function f() {}\n"},
		{"one key of several loses just that key", "// @spec a/b, a/c\nf();\n", 1, "a/b", "// @spec a/c\nf();\n"},
		{"the middle key of three", "// @spec a/b, a/c, a/d\nf();\n", 1, "a/c", "// @spec a/b, a/d\nf();\n"},
		{"a key that is a prefix of another is not confused with it", "// @spec a/b\n// @spec a/bc\n", 1, "a/b", "// @spec a/bc\n"},
		{"a marker with words after it keeps the words", "// @spec a/b: login flow\nf();\n", 1, "a/b", "// login flow\nf();\n"},
		{"an end-of-line marker leaves the code", "x = 1  // @spec a/b\n", 1, "a/b", "x = 1\n"},
		{"CRLF is kept", "# @spec a/b\r\ndef f(): pass\r\n", 1, "a/b", "def f(): pass\r\n"},
		{"an HTML comment goes whole", "<!-- @spec a/b -->\n<div/>\n", 1, "a/b", "<div/>\n"},
		{"a wrong line number changes nothing", "// @spec a/b\n", 5, "a/b", "// @spec a/b\n"},
	} {
		if got := rm(c.in, c.line, c.key); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestFitTranslationFiles(t *testing.T) {
	login := src("src/auth/login.ts", fitLogin)
	tr := func(file, text string) string { return kinds(fit([]FitFile{src(file, text), login}, FitOpts{})) }
	for name, c := range map[string][2]string{
		"a language/en/site.php array file":                       {"src/language/en/site.php", "<?php\n// " + fitM + "\n$lang['login_error'] = 'Wrong email or password';\n"},
		"resources/lang/en/auth.php":                              {"resources/lang/en/auth.php", "<?php\n// " + fitM + "\nreturn ['failed' => 'Wrong email or password'];\n"},
		"translations/messages.fr.yaml":                           {"translations/messages.fr.yaml", "# " + fitM + "\nlogin.error: Mauvais mot de passe\n"},
		"messages.fr.yml next to the code":                        {"src/Resources/messages.fr.yml", "# " + fitM + "\nlogin.error: Mauvais mot de passe\n"},
		"config/locales/en.yml":                                   {"config/locales/en.yml", "en:\n  # " + fitM + "\n  login_error: Wrong email or password\n"},
		"django.po":                                               {"locale/de/LC_MESSAGES/django.po", "# " + fitM + "\nmsgid \"Wrong password\"\nmsgstr \"Falsches Passwort\"\n"},
		"gettext .pot":                                            {"po/app.pot", "# " + fitM + "\nmsgid \"Wrong password\"\nmsgstr \"\"\n"},
		"Android strings.xml":                                     {"app/src/main/res/values-de/strings.xml", "<resources>\n  <!-- " + fitM + " -->\n  <string name=\"login_error\">Falsch</string>\n</resources>\n"},
		"iOS Localizable.strings":                                 {"App/de.lproj/Localizable.strings", "/* " + fitM + " */\n\"login_error\" = \"Falsch\";\n"},
		"Java messages_de_DE.properties":                          {"src/main/resources/messages_de_DE.properties", "# " + fitM + "\nlogin.error=Falsch\n"},
		"public/locales/de.yaml":                                  {"public/locales/de.yaml", "# " + fitM + "\nlogin_error: Falsch\n"},
		"Flutter .arb":                                            {"lib/l10n/app_de.arb", "{\n  \"loginError\": \"Falsch\"\n}\n// " + fitM + "\n"},
		".NET Strings.de.resx":                                    {"Resources/Strings.de.resx", "<root>\n<!-- " + fitM + " -->\n<data name=\"LoginError\"><value>Falsch</value></data>\n</root>\n"},
		"src/i18n/de.yaml":                                        {"src/i18n/de.yaml", "# " + fitM + "\nlogin_error: Falsch\n"},
		"src/languages/en.ts with only entries (content decides)": {"src/languages/en.ts", "export default {\n  // " + fitM + "\n  'login.error': 'Wrong',\n  'cart.title': 'Cart',\n};\n"},
		"application.properties is configuration (boilerplate)":   {"src/main/resources/application.properties", "# " + fitM + "\nserver.port=8080\n"},
	} {
		if got := tr(c[0], c[1]); got != "boilerplate-anchor" {
			t.Errorf("%s: %q, want boilerplate-anchor", name, got)
		}
	}
	logic := "// " + fitM + "\nexport function pickLanguage(user: User, accept: string) {\n  if (!user) return accept.split(\",\")[0];\n  return user.language || \"en\";\n}\n"
	for name, c := range map[string][2]string{
		"languages.ts (a util with logic)":           {"src/util/languages.ts", logic},
		"src/languages/index.ts with logic":          {"src/languages/index.ts", logic},
		"a PHP class in a language directory":        {"src/language/LanguageDetector.php", "<?php\nclass LanguageDetector {\n  // " + fitM + "\n  public function detect($user) {\n    if (!$user) { return 'en'; }\n    return $user->language;\n  }\n}\n"},
		"a controller in a messages/ folder (logic)": {"app/messages/Notifier.php", "<?php\nclass Notifier {\n  // " + fitM + "\n  public function send($u) {\n    if (!$u->active) { return false; }\n    return mail($u->email, 'x', 'y');\n  }\n}\n"},
	} {
		if got := tr(c[0], c[1]); strings.Contains(got, "boilerplate") {
			t.Errorf("%s is not a translation table: %q", name, got)
		}
	}
}

func TestFitStackedMarkers(t *testing.T) {
	mr := map[string]FitReq{
		"acct/login":   {Name: "Sign in with a password", Block: "The system SHALL let a registered person sign in with an email and a password.", Cap: "acct"},
		"acct/session": {Name: "Session needs a signed-in person", Block: "The system SHALL send a person who is not signed in to the sign-in page.", Cap: "acct"},
		"acct/lockout": {Name: "Lock out after repeated failures", Block: "The system SHALL lock a sign-in after five failed passwords.", Cap: "acct"},
	}
	mfit := func(text string) []FitFinding {
		return FitFindings(FitOpts{Files: []FitFile{src("app/Guard.php", text)}, Reqs: mr, CapNames: map[string]bool{"acct": true}})
	}
	unrelated := func(r []FitFinding, key string) bool {
		return slices.ContainsFunc(r, func(f FitFinding) bool { return f.Kind == "unrelated-anchor" && (key == "" || f.Key == key) })
	}
	r := mfit("<?php\nfunction handle() {\n// @spec acct/login\n// @spec acct/session\nif (!signedIn()) { return redirectToSignIn(); }\n}\n")
	check(t, "two stacked markers: the first is not unrelated", !unrelated(r, ""), r)
	r = mfit("<?php\nfunction handle() {\n// @spec acct/login\n// @spec acct/session\n// @spec acct/lockout\nif (!signedIn()) { return redirectToSignIn(); }\n}\n")
	check(t, "three stacked markers: none is unrelated", !unrelated(r, ""), r)
	r = mfit("<?php\nfunction handle() {\n// @spec acct/login\n\n\n\n\n// @spec acct/session\nif (!signedIn()) { return redirectToSignIn(); }\n}\n")
	check(t, "markers more than 3 lines apart do not share (control)", !unrelated(r, "acct/session"), r)
	r = fit([]FitFile{src("src/language/en/site.php", "<?php\n// @spec auth/user-login\n// @spec auth/password-reset\n$lang[\"x\"] = \"y\";\n")}, FitOpts{})
	n := 0
	for _, f := range r {
		if f.Kind == "boilerplate-anchor" {
			n++
		}
	}
	check(t, "stacked markers in a translation file: both flagged", n == 2, r)
	r = fit([]FitFile{src("src/language/en/site.php", "<?php\n// @spec auth/user-login\n")}, FitOpts{})
	check(t, "a marker with no code in a translation file is flagged by the path", slices.ContainsFunc(r, func(f FitFinding) bool { return f.Kind == "boilerplate-anchor" }), r)
}
