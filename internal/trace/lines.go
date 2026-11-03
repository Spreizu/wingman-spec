package trace

import (
	"cmp"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/quality"
)

// LineLint checks the requirement lines of a change's deltas that are not prose: a `Verify:` line names a method; and
// warns when another active change changes the same requirement (the later merge would overwrite the earlier one).
func (c Ctx) LineLint(changeDir string) []Problem {
	out := c.overlaps(changeDir)
	for _, d := range Deltas(changeDir) {
		rel := filepath.ToSlash(relTo(changeDir, d.File))
		for _, r := range d.Reqs {
			if r.Op == "REMOVED" || r.Verify == nil || r.Verified() != "" {
				continue
			}
			out = append(out, Problem{Severity: "error", Kind: "verify-method", File: rel, Line: r.Line,
				Text: fmt.Sprintf("%s:%d: requirement %q says `Verify: %s`: the method is one of %s (a test is the default: drop the line)", rel, r.Line, r.Name, *r.Verify, strings.Join(quality.VerifyMethods, ", "))})
		}
	}
	return out
}

func relTo(base, f string) string {
	if r, err := filepath.Rel(base, f); err == nil {
		return r
	}
	return f
}

// ActiveChanges lists the names of the active changes, sorted.
func (c Ctx) ActiveChanges() []string {
	ents, _ := os.ReadDir(c.R.Changes())
	var out []string
	for _, d := range ents {
		if d.IsDir() && d.Name() != "archive" && !strings.HasPrefix(d.Name(), ".") {
			out = append(out, d.Name())
		}
	}
	slices.Sort(out)
	return out
}

// touches maps each requirement key a change's deltas change (ADDED, MODIFIED, REMOVED, the old name of RENAMED) to
// its delta file and line.
func touches(changeDir string) map[string]Problem {
	out := map[string]Problem{}
	for _, d := range Deltas(changeDir) {
		rel := filepath.ToSlash(relTo(changeDir, d.File))
		for _, r := range d.Reqs {
			out[d.Cap+"/"+r.Slug] = Problem{File: rel, Line: r.Line, Text: r.Op}
		}
		lines := strings.Split(readIf(d.File), "\n")
		for _, rn := range d.Renames {
			n := slices.IndexFunc(lines, func(l string) bool { return strings.Contains(l, rn.From) && strings.Contains(l, "->") })
			out[d.Cap+"/"+rn.FromSlug] = Problem{File: rel, Line: n + 1, Text: "RENAMED"}
		}
	}
	return out
}

func (c Ctx) overlaps(changeDir string) []Problem {
	mine := touches(changeDir)
	if len(mine) == 0 {
		return nil
	}
	var out []Problem
	self := filepath.Base(changeDir)
	for _, name := range c.ActiveChanges() {
		if name == self {
			continue
		}
		for k, o := range touches(c.R.Change(name)) {
			if p, ok := mine[k]; ok {
				out = append(out, Problem{Severity: "warning", Kind: "overlap", File: p.File, Line: p.Line,
					Text: fmt.Sprintf("%s:%d: %s %s, which the active change %q also changes (%s): the change archived later overwrites the other; agree on one, or rebase the later one after the first is archived", p.File, p.Line, p.Text, k, name, o.Text)})
			}
		}
	}
	slices.SortFunc(out, func(a, b Problem) int {
		return cmp.Or(cmp.Compare(a.File, b.File), cmp.Compare(a.Line, b.Line), cmp.Compare(a.Text, b.Text))
	})
	return out
}
