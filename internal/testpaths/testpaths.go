// Package testpaths is the one definition of file kinds: which files are tests, which can carry a
// `[capability/scenario]` tag, which are UI files, and which tests are named after a source file.
// Paths are relative and `/`-separated. Whole path segments and suffix forms only (`latest/`,
// `contest.py`, `attest.go` are not tests).
package testpaths

import (
	"regexp"
	"slices"
	"strings"
)

// CodeExt are the code and test extensions (lower case, without the dot).
var CodeExt = []string{"js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "py", "go", "rb", "rs", "php", "java",
	"kt", "kts", "scala", "cs", "swift", "dart", "ex", "exs", "c", "cc", "cpp", "cxx", "h", "hpp", "clj", "lua", "sh"}

// UIExt are the default UI file extensions (`visual.ui_files` overrides them).
var UIExt = []string{"vue", "svelte", "tsx", "jsx", "astro", "html", "htm", "css", "scss", "sass", "less", "styl", "pcss"}

var (
	codeExtRE     = regexp.MustCompile(`(?i)\.(?:` + strings.Join(CodeExt, "|") + `)$`)
	testDirRE     = regexp.MustCompile(`(?i)^(?:tests?|__tests__|spec)$`)
	testProjDirRE = regexp.MustCompile(`\.Tests?$|[a-z0-9]Tests$`)
	testNameRE    = []*regexp.Regexp{
		regexp.MustCompile(`\.(?:test|spec)\.(?:[cm]?[jt]sx?|vue|svelte)$`),
		regexp.MustCompile(`^test_.+\.(?:py|rb|exs?)$|_test\.(?:py|go|rb|dart|exs|c|cc|cpp|cxx|clj|lua)$`),
		regexp.MustCompile(`_spec\.(?:rb|lua)$`),
		regexp.MustCompile(`_unittest\.(?:cc|cpp|cxx)$`),
		regexp.MustCompile(`Tests?\.(?:php|cs|swift|cpp|cc|cxx)$`),
		regexp.MustCompile(`(?:Test|Tests|Spec|Suite)\.(?:kt|kts|scala)$|Tests?\.(?:java)$`),
		regexp.MustCompile(`[a-z0-9]IT(?:Case)?\.(?:java|kt|kts|scala)$`),
		regexp.MustCompile(`^Test[A-Z0-9_].*\.(?:java|kt|kts|scala)$`),
		regexp.MustCompile(`Spec\.swift$`),
	}
	affixRE = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\.(?:test|spec)$`), regexp.MustCompile(`^test_`), regexp.MustCompile(`_(?:test|spec|unittest)$`),
		nil, // ^Test(?=[A-Z0-9_]): handled in testStem
		regexp.MustCompile(`(?:Tests?|Spec|Suite|IT|ITCase)$`),
	}
	indexNameRE = regexp.MustCompile(`(?i)^(?:index|main|mod|__init__)$`)
	extRE       = regexp.MustCompile(`\.[^.]+$`)
)

// IsTestPath reports whether f is a test by directory or file name.
func IsTestPath(f string) bool {
	parts := strings.Split(f, "/")
	name := parts[len(parts)-1]
	for _, s := range parts[:len(parts)-1] {
		if testDirRE.MatchString(s) || testProjDirRE.MatchString(s) {
			return true
		}
	}
	for _, re := range testNameRE {
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

// IsTestFile reports whether f is a test path with a code extension (the files scanned for tags).
func IsTestFile(f string) bool { return IsTestPath(f) && codeExtRE.MatchString(f) }

// IsCode reports whether f has a code extension.
func IsCode(f string) bool { return codeExtRE.MatchString(f) }

// IsUIFile reports whether f is a UI file by extension; exts overrides UIExt when not empty.
func IsUIFile(f string, exts ...string) bool {
	if len(exts) == 0 {
		exts = UIExt
	}
	_, after, ok := strings.CutLast(f, ".")
	if !ok {
		return false
	}
	return slices.Contains(exts, strings.ToLower(after))
}

func testStem(f string) string {
	n := f[strings.LastIndex(f, "/")+1:]
	n = extRE.ReplaceAllString(n, "")
	for _, re := range affixRE {
		if re == nil {
			if len(n) > 4 && strings.HasPrefix(n, "Test") && (n[4] >= 'A' && n[4] <= 'Z' || n[4] >= '0' && n[4] <= '9' || n[4] == '_') {
				n = n[4:]
			}
			continue
		}
		n = re.ReplaceAllString(n, "")
	}
	return strings.ToLower(n)
}

func sourceStem(f string) string {
	parts := strings.Split(f, "/")
	n := extRE.ReplaceAllString(parts[len(parts)-1], "")
	n = strings.TrimSuffix(n, ".d")
	if indexNameRE.MatchString(n) && len(parts) > 1 {
		n = parts[len(parts)-2]
	}
	return strings.ToLower(n)
}

// TestsFor returns the test files (from tests) whose name is about one of the sources:
// `src/cart.ts` -> `test/cart.test.ts`, `src/cart/index.ts` -> `cart.spec.ts`.
func TestsFor(sources, tests []string) []string {
	want := map[string]bool{}
	for _, f := range sources {
		if !IsTestPath(f) && codeExtRE.MatchString(f) {
			want[sourceStem(f)] = true
		}
	}
	if len(want) == 0 {
		return nil
	}
	var out []string
	for _, t := range tests {
		if want[testStem(t)] {
			out = append(out, t)
		}
	}
	return out
}

type runner struct {
	re   *regexp.Regexp
	use  string // replaces the match ("" keeps it)
	args string
	keep string // "=" keeps --flag=value options, "all" keeps every option
}

var (
	runners = []runner{
		{regexp.MustCompile(`\bvitest\b(?:\s+run\b)?`), "vitest run", "{files}", "="},
		{regexp.MustCompile(`\bjest\b`), "", "{files}", "="},
		{regexp.MustCompile(`\bmocha\b`), "", "{files}", "="},
		{regexp.MustCompile(`\bava\b`), "", "{files}", "="},
		{regexp.MustCompile(`\bnode\b(?:\s+--?[\w-]+(?:=\S+)?)*?\s+--test\b`), "", "{files}", "all"},
		{regexp.MustCompile(`\b(?:python3?\s+-m\s+)?pytest\b`), "", "{files}", "="},
		{regexp.MustCompile(`\brspec\b`), "", "{files}", "="},
		{regexp.MustCompile(`\bdeno\s+test\b`), "", "{files}", "all"},
		{regexp.MustCompile(`\bbun\s+test\b`), "", "{files}", "all"},
		{regexp.MustCompile(`\bgo\s+test\b`), "", "{dirs}", "="},
	}
	wrapperRE  = regexp.MustCompile(`^(?:(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?|bun\s+run\s+)([\w:.-]+)\s*$`)
	segSplitRE = regexp.MustCompile(`\s*(?:&&|\|\||;)\s*`)
	directRE   = regexp.MustCompile(`^(?:npx|node|deno|bun|go|python|pytest|rspec|bundle|env|\w+=)`)
	eqOptRE    = regexp.MustCompile(`^--[\w-]+=\S+$`)
)

// TargetedTemplate derives a `<runner> {files}` (or `{dirs}`) command from the project test command, or "" when no
// segment of it names a runner the table knows. script returns a package.json script body (`npm test`), or "".
func TargetedTemplate(cmd string, script func(name string) string) string {
	return targeted(cmd, script, 0)
}

func targeted(cmd string, script func(string) string, depth int) string {
	for _, seg := range segSplitRE.Split(cmd, -1) {
		seg = strings.TrimSpace(seg)
		if w := wrapperRE.FindStringSubmatch(seg); w != nil && depth == 0 {
			if script == nil {
				continue
			}
			if body := script(w[1]); body != "" {
				if t := targeted(body, script, 1); t != "" {
					if directRE.MatchString(t) {
						return t
					}
					return "npx " + t
				}
			}
			continue
		}
		for _, r := range runners {
			loc := r.re.FindStringIndex(seg)
			if loc == nil || r.args == "" {
				continue
			}
			var opts []string
			for x := range strings.FieldsSeq(seg[loc[1]:]) {
				if (r.keep == "all" && strings.HasPrefix(x, "-")) || (r.keep == "=" && eqOptRE.MatchString(x)) {
					opts = append(opts, x)
				}
			}
			use := r.use
			if use == "" {
				use = seg[loc[0]:loc[1]]
			}
			parts := []string{strings.TrimSpace(seg[:loc[0]]), use}
			parts = append(parts, opts...)
			parts = append(parts, r.args)
			var out []string
			for _, p := range parts {
				if p != "" {
					out = append(out, p)
				}
			}
			return strings.Join(out, " ")
		}
	}
	return ""
}
