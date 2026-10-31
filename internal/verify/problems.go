package verify

import (
	"cmp"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/trace"
)

// Finding is one located finding of `problems`, for editors: absolute path, 1-based line and column. Fix is a
// mechanical repair the editor can offer.
type Finding struct {
	Source      string         `json:"source"`
	Code        string         `json:"code"`
	Severity    string         `json:"severity"`
	Message     string         `json:"message"`
	File        string         `json:"file"`
	Line        int            `json:"line"`
	Col         int            `json:"col"`
	Length      int            `json:"length"`
	Key         string         `json:"key,omitempty"`
	Hint        string         `json:"hint,omitempty"`
	Change      string         `json:"change,omitempty"`
	Requirement string         `json:"requirement,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Fix         map[string]any `json:"fix,omitempty"`
}

func sevOf(s string) string {
	switch s {
	case "error":
		return "error"
	case "warn", "warning":
		return "warning"
	}
	return "info"
}

type hit struct{ line, col, length int }

func fileLines(f string) []string {
	b, err := os.ReadFile(f)
	if err != nil {
		return nil
	}
	return strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
}

func lineOf(f string, n int) (string, bool) {
	ls := fileLines(f)
	if n < 1 || n > len(ls) {
		return "", false
	}
	return ls[n-1], true
}

// locateAll is every occurrence of needle in f.
func locateAll(f, needle string) []hit {
	var out []hit
	for i, l := range fileLines(f) {
		for c := 0; ; {
			j := strings.Index(l[c:], needle)
			if j < 0 {
				break
			}
			out = append(out, hit{i + 1, c + j + 1, len(needle)})
			c += j + len(needle)
		}
	}
	return out
}

var (
	renamedRE    = regexp.MustCompile(`perhaps renamed to (\S+)`)
	renamedTagRE = regexp.MustCompile(`perhaps renamed to \[(\S+)\]`)
	misplacedRE  = regexp.MustCompile(`^(.+?):(\d+): ([a-z-]+):`)
	staleRE      = regexp.MustCompile(`^(.+?):(\d+): `)
	mdPrefixRE   = regexp.MustCompile(`^[^\s:]+\.md:\d+: `)
)

var advisoryGap = map[string]bool{"misplaced-marker": true, "over-anchored": true, "stale-anchor": true, "unconfirmed-requirement": true, "observed-incomplete": true}

func markerSpan(f string, line int) (col, length int) {
	t, _ := lineOf(f, line)
	if c := strings.Index(t, "@spec"); c >= 0 {
		return c + 1, max(5, len(t)-c)
	}
	return 1, max(1, len(t))
}

// driftFindings locates the open drift gaps.
func (e *Env) driftFindings(gaps []trace.Gap, reqs *trace.Reqs) []Finding {
	abs := func(f string) string {
		if filepath.IsAbs(f) {
			return f
		}
		return filepath.Join(e.code, f)
	}
	var out []Finding
	for _, g := range gaps {
		sev := "error"
		if advisoryGap[g.Type] {
			sev = sevOf(cmp.Or(g.Severity, "error"))
		}
		base := Finding{Source: "drift", Code: g.Type, Severity: sev, Key: g.Key, Hint: g.Hint, Message: g.Text}
		push := func(f Finding) {
			f.Source, f.Code, f.Severity, f.Key, f.Hint = base.Source, base.Code, base.Severity, base.Key, base.Hint
			f.Message = cmp.Or(f.Message, g.Text)
			out = append(out, f)
		}
		reqAt := func() (*trace.Requirement, bool) { return reqs.Get(g.Subject) }
		switch g.Type {
		case "observed-incomplete":
			if len(g.Files) > 0 {
				push(Finding{File: filepath.Join(e.R.Specs, g.Files[0]), Line: max(1, g.Line), Col: 1, Length: 1})
			}
		case "unconfirmed-requirement", "unanchored-requirement", "untested-requirement":
			r, ok := reqAt()
			if !ok {
				continue
			}
			f := Finding{File: r.File, Line: r.Line, Col: 1, Length: len("### Requirement: " + r.Name), Requirement: g.Subject}
			switch g.Type {
			case "unanchored-requirement":
				f.Fix = map[string]any{"kind": "accept"}
			case "untested-requirement":
				sc := []any{}
				for _, s := range r.Scenarios {
					sc = append(sc, O("name", s.Name, "id", r.Cap+"/"+s.Slug))
				}
				f.Fix = map[string]any{"kind": "add-test-tag", "scenarios": sc}
			}
			push(f)
		case "orphan-anchor":
			i := strings.Index(g.Subject, "@")
			if i < 0 {
				continue
			}
			k, file := g.Subject[:i], abs(g.Subject[i+1:])
			hits := locateAll(file, k)
			if len(hits) == 0 {
				hits = []hit{{1, 1, 1}}
			}
			var fix map[string]any
			if m := renamedRE.FindStringSubmatch(g.Hint); m != nil {
				fix = map[string]any{"kind": "replace-key", "to": m[1]}
			}
			for _, h := range hits {
				push(Finding{File: file, Line: h.line, Col: h.col, Length: h.length, Fix: fix})
			}
		case "stale-test-tag":
			var fix map[string]any
			if m := renamedTagRE.FindStringSubmatch(g.Hint); m != nil {
				fix = map[string]any{"kind": "replace-key", "to": m[1]}
			}
			for _, f := range g.Files {
				for _, h := range locateAll(abs(f), "["+g.Subject+"]") {
					push(Finding{File: abs(f), Line: h.line, Col: h.col + 1, Length: len(g.Subject), Fix: fix})
				}
			}
		case "misplaced-marker":
			m := misplacedRE.FindStringSubmatch(g.Text)
			if m == nil {
				continue
			}
			f, line := abs(m[1]), toInt(m[2])
			c, l := markerSpan(f, line)
			kind := "move-marker"
			if m[3] == "duplicate-marker" {
				kind = "remove-duplicate"
			}
			push(Finding{File: f, Line: line, Col: c, Length: l, Fix: map[string]any{"kind": kind}, Reason: m[3]})
		case "over-anchored":
			if len(g.Files) == 0 {
				continue
			}
			f, line := abs(g.Files[0]), max(1, g.Line)
			c, l := markerSpan(f, line)
			x := Finding{File: f, Line: line, Col: c, Length: l, Reason: g.Fit}
			if g.Removable {
				x.Fix = map[string]any{"kind": "remove-marker", "key": strings.SplitN(g.Subject, "@", 2)[0]}
			}
			push(x)
		case "stale-anchor":
			m := staleRE.FindStringSubmatch(g.Text)
			if m == nil {
				continue
			}
			f, line := abs(m[1]), toInt(m[2])
			t, _ := lineOf(f, line)
			push(Finding{File: f, Line: line, Col: 1, Length: max(1, len(t)), Fix: map[string]any{"kind": "accept"}})
		case "unsynced-archive":
			push(Finding{File: e.R.Archive(), Line: 1, Col: 1, Length: 1})
		}
	}
	return out
}

// lintFindings locates the lint problems of one change.
func (e *Env) lintFindings(ps []PlanFinding, name, changeDir string) []Finding {
	var out []Finding
	for _, p := range ps {
		if p.Text == "" || p.Severity == "ok" {
			continue
		}
		file := p.File
		if file != "" && !filepath.IsAbs(file) {
			if a := filepath.Join(changeDir, file); exists(a) {
				file = a
			} else {
				file = filepath.Join(e.code, file)
			}
		}
		if file == "" {
			file = filepath.Join(changeDir, "proposal.md")
		}
		f := Finding{Source: "lint", Code: cmp.Or(p.Kind, "lint"), Severity: sevOf(p.Severity), Message: mdPrefixRE.ReplaceAllString(p.Text, ""), File: file, Line: max(1, p.Line), Col: 1, Length: 1, Change: name}
		if t, ok := lineOf(file, f.Line); ok {
			f.Length = max(1, len(t))
		}
		if p.Kind == "missing-why" {
			f.Fix = map[string]any{"kind": "add-why"}
		}
		out = append(out, f)
	}
	return out
}

func (e *Env) activeChanges() []string {
	ents, _ := os.ReadDir(e.R.Changes())
	var out []string
	for _, d := range ents {
		if d.IsDir() && d.Name() != "archive" && !strings.HasPrefix(d.Name(), ".") {
			out = append(out, d.Name())
		}
	}
	slices.Sort(out)
	return out
}

// Problems is every finding of the verifier as one located list, for editors: the lint of the active changes (or the
// named one), drift gaps and the anchor guard of changes that have begun. Read-only; exit 0.
func (e *Env) Problems() error {
	md := trace.Mode(e.Cfg)
	names := e.activeChanges()
	if e.O.Change != "" {
		if _, err := e.changeDir(); err != nil {
			return err
		}
		names = []string{e.O.Change}
	}
	var fs []Finding
	notes := []string{}
	saved := e.O.Change
	for _, name := range names {
		e.O.Change = name
		changeDir := e.R.Change(name)
		vl := e.visualLint(changeDir)
		pr := e.planReport(changeDir, vl)
		ps := slices.Clone(pr.plan)
		for _, v := range vl.problems {
			p := PlanFinding{Severity: v.severity()}
			p.File, _ = v["file"].(string)
			p.Kind, _ = v["kind"].(string)
			p.Text, _ = v["text"].(string)
			if n, ok := v["line"].(float64); ok {
				p.Line = int(n)
			} else if n, ok := v["line"].(int); ok {
				p.Line = n
			}
			if p.File == "" {
				p.File = tasksFile(changeDir)
			}
			ps = append(ps, p)
		}
		fs = append(fs, e.lintFindings(ps, name, changeDir)...)
		if base := e.changeBase(); base != "" {
			if rep, lvl := e.guardReport(changeDir, base, "change", nil); rep != nil {
				sev := "warning"
				if lvl == "error" {
					sev = "error"
				}
				for _, x := range rep.Findings {
					f := x.File
					if !filepath.IsAbs(f) {
						f = filepath.Join(e.code, f)
					}
					fs = append(fs, Finding{Source: "guard", Code: x.Kind, Severity: sev, Message: x.Text, File: f, Line: max(1, x.Line), Col: 1, Length: 1, Key: x.Key, Change: name})
				}
			}
		}
	}
	e.O.Change = saved
	if md != "off" {
		tr := e.tr()
		r := tr.Drift("", false)
		pendReq, pendScn := map[string]bool{}, map[string]bool{}
		for _, name := range e.activeChanges() {
			for _, d := range trace.Deltas(e.R.Change(name)) {
				for _, rn := range d.Renames {
					pendReq[d.Cap+"/"+rn.ToSlug] = true
				}
				for _, q := range d.Reqs {
					if q.Op == "ADDED" || q.Op == "MODIFIED" {
						pendReq[d.Cap+"/"+q.Slug] = true
						for _, s := range q.Scenarios {
							pendScn[d.Cap+"/"+s.Slug] = true
						}
					}
				}
			}
		}
		var open []trace.Gap
		for _, g := range r.Open {
			k, _, _ := strings.Cut(g.Subject, "@")
			if (g.Type == "orphan-anchor" && pendReq[k]) || (g.Type == "stale-test-tag" && pendScn[g.Subject]) {
				continue
			}
			open = append(open, g)
		}
		fs = append(fs, e.driftFindings(open, trace.Living(e.R.LivingSpecs()))...)
		notes = append(notes, r.Notes...)
	}
	fs = finishFindings(fs)
	counts := map[string]int{"error": 0, "warning": 0, "info": 0}
	for _, f := range fs {
		counts[f.Severity]++
	}
	e.print(O("ok", counts["error"] == 0, "mode", md, "counts", O("error", counts["error"], "warning", counts["warning"], "info", counts["info"]), "findings", list(fs), "notes", NonEmpty(notes)))
	return nil
}

// finishFindings drops identical findings and sorts: errors first, then by file and line.
func finishFindings(fs []Finding) []Finding {
	seen := map[string]bool{}
	var out []Finding
	for _, f := range fs {
		k := fmt.Sprint(f.Source, "\x00", f.Code, "\x00", f.File, "\x00", f.Line, "\x00", f.Message)
		if !seen[k] {
			seen[k] = true
			out = append(out, f)
		}
	}
	rank := map[string]int{"error": 0, "warning": 1, "info": 2}
	slices.SortStableFunc(out, func(a, b Finding) int {
		return cmp.Or(cmp.Compare(rank[a.Severity], rank[b.Severity]), strings.Compare(a.File, b.File), cmp.Compare(a.Line, b.Line))
	})
	return out
}
