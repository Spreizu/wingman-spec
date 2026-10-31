package spec

import (
	"fmt"
	"slices"
	"strings"
)

// MergeError lists every conflict of a delta against a living spec.
type MergeError struct {
	Capability string
	Problems   []Problem
}

func (e *MergeError) Error() string {
	msgs := make([]string, len(e.Problems))
	for i, p := range e.Problems {
		msgs[i] = p.String()
	}
	return fmt.Sprintf("%s: %s", e.Capability, strings.Join(msgs, "; "))
}

// PurposePlaceholder is the Purpose a new capability gets when its delta has none (lint warns about it first).
const PurposePlaceholder = "TBD: say in one or two sentences what this capability is for and who relies on it."

// Merge applies a delta to a living spec and returns the new living spec text. living is "" for a new capability.
// The order is RENAMED, REMOVED, MODIFIED, ADDED. Every conflict is reported, and nothing is merged when there is one.
func Merge(capability, living string, d *Delta) (string, error) {
	if len(d.Problems) > 0 {
		return "", &MergeError{capability, d.Problems}
	}
	var sp *Living
	if strings.TrimSpace(living) == "" {
		if len(d.Modified)+len(d.Removed)+len(d.Renamed) > 0 {
			return "", &MergeError{capability, []Problem{{1, "the capability has no living spec yet: only ## ADDED is allowed"}}}
		}
		purpose := d.Purpose
		if purpose == "" {
			purpose = PurposePlaceholder
		}
		sp = &Living{Title: capability, Prelude: fmt.Sprintf("# %s\n\n## Purpose\n%s", capability, purpose)}
	} else {
		sp = ParseLiving(living)
		if len(sp.Problems) > 0 {
			return "", &MergeError{capability + " (living spec)", sp.Problems}
		}
	}
	var probs []Problem
	idx := func(name string) int {
		return slices.IndexFunc(sp.Requirements, func(r Requirement) bool { return Key(r.Name) == Key(name) })
	}
	for _, rn := range d.Renamed {
		i := idx(rn.From)
		switch {
		case i < 0:
			probs = append(probs, Problem{rn.Line, fmt.Sprintf("RENAMED: no requirement %q", rn.From)})
		case idx(rn.To) >= 0:
			probs = append(probs, Problem{rn.Line, fmt.Sprintf("RENAMED: a requirement %q already exists", rn.To)})
		default:
			r := &sp.Requirements[i]
			first, rest, _ := strings.Cut(r.Text, "\n")
			r.Text = strings.Replace(first, r.Name, rn.To, 1) + suffix(rest)
			r.Name = rn.To
		}
	}
	for _, rm := range d.Removed {
		if i := idx(rm.Name); i < 0 {
			probs = append(probs, Problem{rm.Line, fmt.Sprintf("REMOVED: no requirement %q", rm.Name)})
		} else {
			sp.Requirements = slices.Delete(sp.Requirements, i, i+1)
		}
	}
	for _, m := range d.Modified {
		if i := idx(m.Name); i < 0 {
			probs = append(probs, Problem{m.Line, fmt.Sprintf("MODIFIED: no requirement %q (a new one goes under ## ADDED)", m.Name)})
		} else {
			sp.Requirements[i] = m
		}
	}
	for _, a := range d.Added {
		if idx(a.Name) >= 0 {
			probs = append(probs, Problem{a.Line, fmt.Sprintf("ADDED: requirement %q already exists (a change to it goes under ## MODIFIED)", a.Name)})
			continue
		}
		sp.Requirements = append(sp.Requirements, a)
	}
	if len(probs) > 0 {
		return "", &MergeError{capability, probs}
	}
	return sp.Render(), nil
}

func suffix(rest string) string {
	if rest == "" {
		return ""
	}
	return "\n" + rest
}
