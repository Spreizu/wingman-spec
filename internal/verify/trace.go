package verify

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/report"
)

// tagAt is one test tag with where it is.
type tagAt struct {
	Tag  string `json:"tag"`
	File string `json:"file"`
	Line int    `json:"line"`
	Why  string `json:"why,omitempty"`
}

// tagLocations reads every `[cap/slug]` tag of the test files with its line.
func tagLocations(files []string, root string) []tagAt {
	var out []tagAt
	for _, f := range files {
		fh, err := os.Open(filepath.Join(root, f))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for n := 1; sc.Scan(); n++ {
			for _, m := range quality.TagRE.FindAllStringSubmatch(sc.Text(), -1) {
				out = append(out, tagAt{Tag: m[1], File: f, Line: n})
			}
		}
		_ = fh.Close()
	}
	return out
}

// Trace links scenarios to tests: the scenarios no test tags (the change's, or every living one) and the tags that
// name a scenario that is in no spec (living or an active change's delta) of a capability the specs know.
func (e *Env) Trace() error {
	scope := "the living specs"
	dir := e.R.LivingSpecs()
	if e.O.Change != "" {
		changeDir, err := e.changeDir()
		if err != nil {
			return err
		}
		scope, dir = "change "+e.O.Change, filepath.Join(changeDir, "specs")
	}
	scens := quality.SpecScenarios(dir)
	files := e.testFiles()
	at := tagLocations(files, e.code)
	tags := map[string][]string{}
	for _, t := range at {
		if !slices.Contains(tags[t.Tag], t.File) {
			tags[t.Tag] = append(tags[t.Tag], t.File)
		}
	}
	res := quality.Trace(scens, tags, !e.Cfg.Visual.Off)

	known, caps := map[string]bool{}, map[string]bool{}
	all := quality.SpecScenarios(e.R.LivingSpecs())
	if cs, err := change.List(e.R); err == nil {
		for _, c := range cs {
			all = append(all, quality.SpecScenarios(filepath.Join(e.R.Changes(), c.Name, "specs"))...)
		}
	}
	for _, s := range all {
		known[s.ID], caps[s.Capability] = true, true
	}
	unknown := []tagAt{}
	for _, t := range at {
		cap, _, _ := strings.Cut(t.Tag, "/")
		if caps[cap] && !known[t.Tag] {
			t.Why = "no such scenario in the specs"
			unknown = append(unknown, t)
		}
	}
	rel := func(f string) string {
		if r, err := filepath.Rel(e.code, f); err == nil && !strings.HasPrefix(r, "..") {
			return r
		}
		return f
	}
	untested := []any{}
	var lines []string
	for _, s := range res.Missing {
		untested = append(untested, O("id", s.ID, "requirement", s.Requirement, "file", rel(s.File), "line", s.Line))
		lines = append(lines, fmt.Sprintf("%s:%d: untested: [%s] (requirement %q): no test carries the tag", rel(s.File), s.Line, s.ID, s.Requirement))
	}
	for _, t := range unknown {
		lines = append(lines, fmt.Sprintf("%s:%d: unknown tag: [%s]: %s", t.File, t.Line, t.Tag, t.Why))
	}
	ok := len(res.Missing) == 0 && len(unknown) == 0
	e.saySkipped()
	if e.O.Text {
		for _, l := range lines {
			fmt.Fprintln(e.Out, l)
		}
		verdict := "ok"
		if !ok {
			verdict = "FAILED"
		}
		fmt.Fprintf(e.Out, "trace %s: %d scenarios, %d tagged, %d visual, %d verified without a test, %d untested, %d unknown tags: %s\n", scope, res.Total, len(res.Covered), len(res.Visual), len(res.Verified), len(res.Missing), len(unknown), verdict)
		if !ok {
			return quit(Fail)
		}
		return nil
	}
	x := O("ok", ok, "scope", scope, "scenarios", res.Total, "test_files", len(files), "tagged", res.Covered, "visual", res.Visual,
		"verified", res.Verified, "untested", untested, "unknown_tags", unknown, "problems", list(lines), "skipped", e.skippedObj())
	if !ok {
		x.Set("next", "tag a test of each untested scenario with `[<capability>/<scenario-slug>]` in its title (or, when no test can prove the requirement, add `Verify: inspection|analysis|demonstration` to it); fix or drop each unknown tag")
	}
	var fs []report.Finding
	for _, s := range res.Missing {
		fs = append(fs, report.Finding{Source: "trace", Code: "untested", Severity: "error", Message: fmt.Sprintf("no test carries [%s]", s.ID), File: rel(s.File), Line: s.Line})
	}
	for _, t := range unknown {
		fs = append(fs, report.Finding{Source: "trace", Code: "unknown-tag", Severity: "error", Message: t.Why, File: t.File, Line: t.Line, Key: t.Tag})
	}
	return e.writeReport("Trace", fs, x, !ok)
}
