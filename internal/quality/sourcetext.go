package quality

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
)

var (
	srcDirs      = []string{"src", "app", "lib", "components", "pages", "views", "composables", "stores", "styles"}
	srcExtRE     = regexp.MustCompile(`^(?:vue|svelte|css|scss|sass|less|styl|astro|html?|[cm]?[jt]sx?)`)
	srcDirOnly   = regexp.MustCompile(`^(?:\.{0,2}[/\\])*(?:src|app|lib|components|pages|views|composables|stores|styles)[/\\]?$`)
	importLine   = regexp.MustCompile(`^\s*(?:import\b|export\b[^=]*\bfrom\b|(?:const|let|var)\s+[^=]+=\s*(?:await\s+)?(?:require|import)\s*\()|\bvi\.mock\s*\(|\bjest\.mock\s*\(`)
	readCall     = regexp.MustCompile(`\b(readFileSync|readFile|read_text|read_bytes|readText|createReadStream)\s*\(|\bopen\s*\([^)]*\)\s*\.\s*read\b|\bwith\s+open\s*\(|\bfs\.promises\.readFile\b|\bfs/promises\b|\bBun\.file\s*\(`)
	optOutRE     = regexp.MustCompile(`source-text-ok\b\s*[:\-–]?\s*(\S.{5,})`)
	dataExtRE    = regexp.MustCompile(`(?i)\.(json|txt|csv|md|ya?ml|png|jpe?g|svg)$`)
	rawImportRE  = regexp.MustCompile(`(?:from\s+|import\s*\(\s*)(?:'([^'"]+)\?raw'|"([^'"]+)\?raw")`)
	rawSourceRE  = regexp.MustCompile(`\.(vue|svelte|css|scss|sass|less|styl|astro|[cm]?[jt]sx?|html?|py)$|(^|/)(src|app|lib|components)/`)
	commentStart = regexp.MustCompile(`^\s*(//|#|\*)`)
	hasExtRE     = regexp.MustCompile(`(?i)\.[a-z]+$`)
)

func isAlnum(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// sourceLiteral reports whether the content of a quoted literal names a source path: a source directory at the start
// or after . / \, or a source-file extension.
func sourceLiteral(c string) bool {
	for k := 0; k < len(c); k++ {
		if k == 0 || strings.IndexByte(`./\`, c[k-1]) >= 0 {
			for _, d := range srcDirs {
				if strings.HasPrefix(c[k:], d) {
					return true
				}
			}
		}
		if c[k] == '.' {
			if m := srcExtRE.FindString(c[k+1:]); m != "" {
				e := k + 1 + len(m)
				if e == len(c) || !isAlnum(c[e]) {
					return true
				}
			}
		}
	}
	return false
}

// quotedLiterals finds '...', "..." and `...` literals of one line that name source paths.
func quotedLiterals(l string) []string {
	var out []string
	for i := 0; i < len(l); i++ {
		q := l[i]
		if q != '\'' && q != '"' && q != '`' {
			continue
		}
		j := i + 1 + strings.IndexAny(l[i+1:], "'\"`")
		if j <= i || l[j] != q {
			continue
		}
		if c := l[i+1 : j]; sourceLiteral(c) {
			out = append(out, c)
			i = j
		}
	}
	return out
}

// SourceTextFinding is a place where a test reads source code as text.
type SourceTextFinding struct {
	Line int    `json:"line"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// SourceTextFindings returns the findings for one test file and the reason of its `source-text-ok:` opt-out ("" without).
func SourceTextFindings(file, rel string) ([]SourceTextFinding, string) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, ""
	}
	s := string(b)
	ls := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	type lit struct {
		line int
		lit  string
	}
	var lits []lit
	for i, l := range ls {
		if importLine.MatchString(l) {
			continue
		}
		for _, c := range quotedLiterals(l) {
			if !dataExtRE.MatchString(c) {
				lits = append(lits, lit{i + 1, c})
			}
		}
	}
	near := func(n int) []lit {
		var out []lit
		for _, x := range lits {
			if x.line >= n-6 && x.line <= n+1 {
				out = append(out, x)
			}
		}
		return out
	}
	hasExt := func(x lit) bool { return hasExtRE.MatchString(x.lit) }
	var out []SourceTextFinding
	for i, l := range ls {
		if m := rawImportRE.FindStringSubmatch(l); m != nil {
			p := m[1] + m[2]
			if rawSourceRE.MatchString(p) {
				out = append(out, SourceTextFinding{i + 1, "raw-import", fmt.Sprintf("%s:%d: imports %s?raw, i.e. reads source code as text", rel, i+1, p)})
				continue
			}
		}
		if !readCall.MatchString(l) || commentStart.MatchString(l) {
			continue
		}
		cand := near(i + 1)
		if len(cand) == 0 {
			cand = lits
		}
		if len(cand) == 0 {
			continue
		}
		pick := cand[0]
		if k := slices.IndexFunc(cand, hasExt); k >= 0 {
			pick = cand[k]
		}
		if srcDirOnly.MatchString(pick.lit) && !slices.ContainsFunc(lits, hasExt) {
			continue
		}
		where := ""
		if pick.line != i+1 {
			where = fmt.Sprintf(" (path on line %d)", pick.line)
		}
		out = append(out, SourceTextFinding{i + 1, "read-source", fmt.Sprintf("%s:%d: reads %s%s as text", rel, i+1, pick.lit, where)})
	}
	opt := ""
	if m := optOutRE.FindStringSubmatch(s); m != nil {
		opt = cut(strings.TrimSpace(m[1]), 160)
	}
	return out, opt
}

// SourceTextFix explains how to replace a source-text test.
const SourceTextFix = "Tests must assert behaviour, not source text: matching CSS or markup in a .vue/.css file breaks on an equivalent refactor and passes on a broken page. Assert rendered output instead (mount the component and query the DOM: roles, text, attributes, classes on elements), and put layout/look in a ```visual scenario (the visual check measures columns, overflow and visibility in a real browser). If reading the source really is the behaviour under test (e.g. a code generator or a linter), add the comment `source-text-ok: <reason>` to the test file."
