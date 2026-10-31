package spec

import (
	"fmt"
	"slices"
	"strings"
)

// Synced reports what of a delta the living spec does not show yet: an ADDED or MODIFIED block that differs, a
// REMOVED requirement still present, a RENAMED one under its old name. No problems means the delta is merged.
func Synced(living string, d *Delta) []Problem {
	if strings.TrimSpace(living) == "" {
		if d.Empty() {
			return nil
		}
		return []Problem{{1, "not merged: the capability has no living spec"}}
	}
	sp := ParseLiving(living)
	find := func(name string) (Requirement, bool) {
		i := slices.IndexFunc(sp.Requirements, func(r Requirement) bool { return Key(r.Name) == Key(name) })
		if i < 0 {
			return Requirement{}, false
		}
		return sp.Requirements[i], true
	}
	var probs []Problem
	for _, r := range slices.Concat(d.Added, d.Modified) {
		got, ok := find(r.Name)
		switch {
		case !ok:
			probs = append(probs, Problem{r.Line, fmt.Sprintf("not merged: requirement %q is missing from the living spec", r.Name)})
		case norm(got.Text) != norm(r.Text):
			probs = append(probs, Problem{r.Line, fmt.Sprintf("not merged: requirement %q differs from the living spec", r.Name)})
		}
	}
	for _, r := range d.Removed {
		if _, ok := find(r.Name); ok {
			probs = append(probs, Problem{r.Line, fmt.Sprintf("not merged: removed requirement %q is still in the living spec", r.Name)})
		}
	}
	for _, rn := range d.Renamed {
		if _, ok := find(rn.From); ok {
			probs = append(probs, Problem{rn.Line, fmt.Sprintf("not merged: %q is not renamed to %q yet", rn.From, rn.To)})
		}
	}
	return probs
}

// norm ignores trailing spaces and blank-line runs.
func norm(s string) string {
	var out []string
	for l := range strings.SplitSeq(s, "\n") {
		if l = strings.TrimRight(l, " \t\r"); l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}
