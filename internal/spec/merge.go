package spec

import (
	"crypto/sha256"
	"encoding/hex"
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

// Base is what the living spec of one capability looked like when the change was planned: whether it existed, and the
// hash of each requirement the delta renames, removes or modifies (keyed by Key of the living name).
type Base struct {
	Exists       bool              `json:"exists"`
	Requirements map[string]string `json:"requirements,omitempty"`
}

// Hash is the hash of a requirement block, blind to trailing spaces and blank-line runs.
func Hash(text string) string {
	s := sha256.Sum256([]byte(norm(text)))
	return hex.EncodeToString(s[:8])
}

// baseName is the living name whose text a delta entry starts from: a MODIFIED requirement that a RENAMED line
// renames starts from the old name.
func (d *Delta) baseNames() []string {
	var out []string
	for _, rn := range d.Renamed {
		out = append(out, rn.From)
	}
	for _, r := range d.Removed {
		out = append(out, r.Name)
	}
	for _, m := range d.Modified {
		name := m.Name
		for _, rn := range d.Renamed {
			if Key(rn.To) == Key(m.Name) {
				name = rn.From
			}
		}
		if !slices.ContainsFunc(out, func(n string) bool { return Key(n) == Key(name) }) {
			out = append(out, name)
		}
	}
	return out
}

// BaseOf records the base of d in the living spec as it is now. A requirement the living spec lacks gets no entry
// (the merge reports it as missing).
func BaseOf(living string, d *Delta) Base {
	if strings.TrimSpace(living) == "" {
		return Base{}
	}
	b := Base{Exists: true, Requirements: map[string]string{}}
	sp := ParseLiving(living)
	for _, n := range d.baseNames() {
		if i := slices.IndexFunc(sp.Requirements, func(r Requirement) bool { return Key(r.Name) == Key(n) }); i >= 0 {
			b.Requirements[Key(n)] = Hash(sp.Requirements[i].Text)
		}
	}
	if len(b.Requirements) == 0 {
		b.Requirements = nil
	}
	return b
}

// Merge applies a delta to a living spec and returns the new living spec text. living is "" for a new capability.
//
// The semantics are fixed: RENAMED, then REMOVED, then MODIFIED (a MODIFIED block replaces the whole requirement, and
// names it by its new name when it is also renamed), then ADDED (appended in delta order). A living spec that already
// shows the delta's result is returned unchanged, so a merge is idempotent (a removed or renamed-away requirement counts
// as merged only when base records that it existed). Every case that has more than one reading is
// refused, all problems are reported at once, and nothing is merged when there is one. base (nil: not checked) is what
// the living spec looked like when the change was planned; a requirement that changed since is refused.
func Merge(capability, living string, d *Delta, base *Base) (string, error) {
	conflict := func(probs []Problem) (string, error) { return "", &MergeError{capability, probs} }
	if probs := append(slices.Clone(d.Problems), deltaConflicts(d)...); len(probs) > 0 {
		return conflict(probs)
	}
	isNew := strings.TrimSpace(living) == ""
	var sp *Living
	if isNew {
		if len(d.Modified)+len(d.Removed)+len(d.Renamed) > 0 {
			return conflict([]Problem{{Line: 1, Msg: "the capability has no living spec yet: only ## ADDED is allowed"}})
		}
	} else {
		sp = ParseLiving(living)
		probs := slices.Clone(sp.Problems)
		seen := map[string]int{}
		for _, r := range sp.Requirements {
			if first, ok := seen[Key(r.Name)]; ok {
				probs = append(probs, Problem{Line: r.Line, Msg: fmt.Sprintf("requirement %q is in the living spec twice (lines %d and %d): fix the living spec first", r.Name, first, r.Line)})
			}
			seen[Key(r.Name)] = r.Line
		}
		if len(probs) > 0 {
			return "", &MergeError{capability + " (living spec)", probs}
		}
		if len(Synced(living, d)) == 0 && gonePinned(d, base) {
			return living, nil // already merged
		}
		if d.Purpose != "" {
			return conflict([]Problem{{Line: 1, Msg: "## Purpose is only for a new capability, and this one has a living spec: remove it from the delta"}})
		}
	}
	if base != nil {
		if probs := baseConflicts(sp, d, base); len(probs) > 0 {
			return conflict(probs)
		}
	}
	if isNew {
		purpose := d.Purpose
		if purpose == "" {
			purpose = PurposePlaceholder
		}
		sp = &Living{Title: capability, Prelude: fmt.Sprintf("# %s\n\n## Purpose\n%s", capability, purpose)}
	}
	var probs []Problem
	idx := func(name string) int {
		return slices.IndexFunc(sp.Requirements, func(r Requirement) bool { return Key(r.Name) == Key(name) })
	}
	for _, rn := range d.Renamed {
		i := idx(rn.From)
		switch {
		case i < 0:
			probs = append(probs, Problem{Line: rn.Line, Msg: fmt.Sprintf("RENAMED: no requirement %q", rn.From)})
		case idx(rn.To) >= 0:
			probs = append(probs, Problem{Line: rn.Line, Msg: fmt.Sprintf("RENAMED: a requirement %q already exists", rn.To)})
		default:
			r := &sp.Requirements[i]
			_, rest, _ := strings.Cut(r.Text, "\n")
			r.Text = "### Requirement: " + rn.To + suffix(rest)
			r.Name = rn.To
		}
	}
	for _, rm := range d.Removed {
		if i := idx(rm.Name); i < 0 {
			probs = append(probs, Problem{Line: rm.Line, Msg: fmt.Sprintf("REMOVED: no requirement %q", rm.Name)})
		} else {
			sp.Requirements = slices.Delete(sp.Requirements, i, i+1)
		}
	}
	for _, m := range d.Modified {
		if i := idx(m.Name); i < 0 {
			probs = append(probs, Problem{Line: m.Line, Msg: fmt.Sprintf("MODIFIED: no requirement %q (a new one goes under ## ADDED)", m.Name)})
		} else {
			sp.Requirements[i] = m
		}
	}
	for _, a := range d.Added {
		if idx(a.Name) >= 0 {
			probs = append(probs, Problem{Line: a.Line, Msg: fmt.Sprintf("ADDED: requirement %q already exists (a change to it goes under ## MODIFIED)", a.Name)})
			continue
		}
		sp.Requirements = append(sp.Requirements, a)
	}
	if len(probs) > 0 {
		return conflict(probs)
	}
	out := sp.Render()
	if p := roundTrip(out, sp); p != "" {
		return conflict([]Problem{{Line: 1, Msg: "the merged spec would not read back the same (" + p + "): nothing was written; fix the delta's markdown"}})
	}
	return out, nil
}

// gonePinned reports whether every requirement the delta removes or renames away existed when the change was planned,
// so its absence now is this delta's own earlier merge and not a name that never existed.
func gonePinned(d *Delta, base *Base) bool {
	var gone []string
	for _, r := range d.Removed {
		gone = append(gone, r.Name)
	}
	for _, rn := range d.Renamed {
		gone = append(gone, rn.From)
	}
	for _, n := range gone {
		if base == nil || base.Requirements[Key(n)] == "" {
			return false
		}
	}
	return true
}

// deltaConflicts refuses a delta that names one requirement more than once, so no order of the operations matters:
// a name appears in at most one of ADDED, MODIFIED, REMOVED and the old side of RENAMED; a new name of RENAMED is new
// (not an old name of another line, not ADDED or REMOVED) and may only appear again under MODIFIED. Scenario names are
// unique within a requirement.
func deltaConflicts(d *Delta) []Problem {
	var out []Problem
	seen := map[string]int{}
	note := func(name string, line int) {
		k := Key(name)
		if first, ok := seen[k]; ok {
			out = append(out, Problem{Line: line, Msg: fmt.Sprintf("requirement %q is named twice in this delta (first on line %d)", name, first)})
			return
		}
		seen[k] = line
	}
	for _, x := range slices.Concat(d.Added, d.Removed) {
		note(x.Name, x.Line)
	}
	for _, rn := range d.Renamed {
		note(rn.From, rn.Line)
	}
	renamedTo := map[string]int{}
	for _, rn := range d.Renamed {
		switch {
		case Key(rn.From) == Key(rn.To):
			out = append(out, Problem{Line: rn.Line, Msg: fmt.Sprintf("RENAMED %q to the same name (a change of case or spacing is not a rename)", rn.From)})
		case renamedTo[Key(rn.To)] > 0:
			out = append(out, Problem{Line: rn.Line, Msg: fmt.Sprintf("RENAMED: two requirements get the name %q (first on line %d)", rn.To, renamedTo[Key(rn.To)])})
		default:
			if first, ok := seen[Key(rn.To)]; ok {
				out = append(out, Problem{Line: rn.Line, Msg: fmt.Sprintf("RENAMED to %q, which line %d also names: rename chains, swaps and renaming onto an ADDED or REMOVED name are refused", rn.To, first)})
			}
		}
		renamedTo[Key(rn.To)] = rn.Line
	}
	for _, m := range d.Modified {
		note(m.Name, m.Line)
	}
	for _, r := range slices.Concat(d.Added, d.Modified) {
		names := map[string]int{}
		for _, s := range r.Scenarios {
			if first, ok := names[Slug(s.Name)]; ok {
				out = append(out, Problem{Line: s.Line, Msg: fmt.Sprintf("scenario %q repeats the one on line %d", s.Name, first)})
			}
			names[Slug(s.Name)] = s.Line
		}
	}
	return out
}

// baseConflicts compares the living spec (nil: none) with the base recorded when the change was planned.
func baseConflicts(sp *Living, d *Delta, base *Base) []Problem {
	const again = "re-read it, carry what changed into this delta, then run `wingman-spec sync <change> --rebase`"
	switch {
	case sp == nil && base.Exists:
		return []Problem{{Line: 1, Msg: "the living spec was deleted after this change was planned; " + again}}
	case sp != nil && !base.Exists:
		return []Problem{{Line: 1, Msg: "another change created this capability after this change was planned; " + again}}
	case sp == nil:
		return nil
	}
	var out []Problem
	for _, n := range d.baseNames() {
		want, ok := base.Requirements[Key(n)]
		i := slices.IndexFunc(sp.Requirements, func(r Requirement) bool { return Key(r.Name) == Key(n) })
		switch {
		case i < 0:
			continue // reported as missing by the merge
		case !ok:
			out = append(out, Problem{Line: 1, Msg: fmt.Sprintf("no base recorded for requirement %q: run `wingman-spec lint <change>` (it records the base), then sync again", n)})
		case Hash(sp.Requirements[i].Text) != want:
			out = append(out, Problem{Line: sp.Requirements[i].Line, Msg: fmt.Sprintf("base changed: requirement %q in the living spec changed after this change was planned (another change was archived); %s", n, again)})
		}
	}
	return out
}

// roundTrip checks that text parses back into exactly sp's requirements, prelude and tail.
func roundTrip(text string, sp *Living) string {
	back := ParseLiving(text)
	switch {
	case len(back.Problems) > 0:
		return back.Problems[0].String()
	case len(back.Requirements) != len(sp.Requirements):
		return fmt.Sprintf("%d requirements instead of %d", len(back.Requirements), len(sp.Requirements))
	case norm(back.Prelude) != norm(sp.Prelude) || norm(back.Tail) != norm(sp.Tail):
		return "the text around the requirements moved"
	}
	for i, r := range back.Requirements {
		if r.Name != sp.Requirements[i].Name || norm(r.Text) != norm(sp.Requirements[i].Text) {
			return fmt.Sprintf("requirement %q reads back differently", sp.Requirements[i].Name)
		}
	}
	return ""
}

func suffix(rest string) string {
	if rest == "" {
		return ""
	}
	return "\n" + rest
}
