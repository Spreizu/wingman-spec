package trace

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/quality"
)

// LineLint checks the requirement lines of a change's deltas that are not prose: a `Verify:` line names a method.
func (c Ctx) LineLint(changeDir string) []Problem {
	var out []Problem
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
