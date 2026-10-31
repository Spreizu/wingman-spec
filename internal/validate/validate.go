// Package validate checks a change (proposal and delta specs, against the living specs) and the living specs.
package validate

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/spec"
)

// Level is how bad an issue is.
type Level string

// Issue levels.
const (
	Error   Level = "error"
	Warning Level = "warning"
)

// Issue is one finding, with the file (relative to the specs root) and 1-based line.
type Issue struct {
	Level Level  `json:"level"`
	File  string `json:"file"`
	Line  int    `json:"line,omitempty"`
	Msg   string `json:"message"`
}

func (i Issue) String() string {
	if i.Line > 0 {
		return fmt.Sprintf("%s:%d: %s", i.File, i.Line, i.Msg)
	}
	return fmt.Sprintf("%s: %s", i.File, i.Msg)
}

// Report is the result of a validation.
type Report struct {
	Target string  `json:"target"`
	Valid  bool    `json:"valid"`
	Issues []Issue `json:"issues"`
}

func (r *Report) add(file string, line int, format string, a ...any) {
	r.Issues = append(r.Issues, Issue{Error, file, line, fmt.Sprintf(format, a...)})
}

func (r *Report) done() *Report {
	r.Valid = !slices.ContainsFunc(r.Issues, func(i Issue) bool { return i.Level == Error })
	if r.Issues == nil {
		r.Issues = []Issue{}
	}
	return r
}

// MinPurpose is the shortest accepted ## Purpose paragraph.
const MinPurpose = 50

var (
	shallMust = regexp.MustCompile(`\b(SHALL|MUST)\b`)
	specsNone = regexp.MustCompile(`(?im)^Specs:\s*none\b`)
	h2Line    = regexp.MustCompile(`(?m)^##\s+(.*?)\s*$`)
	comment   = regexp.MustCompile(`(?s)<!--.*?-->`)
)

// SpecsNone reports whether a proposal declares `Specs: none` (a change without delta specs).
func SpecsNone(proposal string) bool { return specsNone.MatchString(proposal) }

// Change validates the change folder changeDir; livingDir holds the living specs (specs/<capability>.md).
// rel turns a path into the one reported.
func Change(changeDir, livingDir string, rel func(string) string) (*Report, error) {
	r := &Report{Target: filepath.Base(changeDir)}
	if st, err := os.Stat(changeDir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("no change %q (looked in %s)", r.Target, rel(changeDir))
	}
	ppath := filepath.Join(changeDir, "proposal.md")
	pb, err := os.ReadFile(ppath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		r.add(rel(ppath), 0, "missing proposal.md")
	case err != nil:
		return nil, err
	default:
		proposal(r, rel(ppath), string(pb))
	}
	deltas, err := filepath.Glob(filepath.Join(changeDir, "specs", "*.md"))
	if err != nil {
		return nil, err
	}
	nested, _ := filepath.Glob(filepath.Join(changeDir, "specs", "*", "spec.md"))
	for _, n := range nested {
		r.add(rel(n), 0, "delta specs are specs/<capability>.md now: run `wingman-spec import openspec`")
	}
	none := SpecsNone(string(pb))
	switch {
	case none && len(deltas) > 0:
		r.add(rel(ppath), 0, "the proposal says `Specs: none` but the change has %d delta spec(s): remove the line or the specs", len(deltas))
	case !none && len(deltas) == 0 && pb != nil:
		r.add(rel(ppath), 0, "no delta specs: write specs/<capability>.md, or add the line `Specs: none` for a change without behavior changes")
	}
	for _, d := range deltas {
		if err := delta(r, d, livingDir, rel); err != nil {
			return nil, err
		}
	}
	return r.done(), nil
}

func proposal(r *Report, file, src string) {
	have := map[string]bool{}
	for _, m := range h2Line.FindAllStringSubmatch(src, -1) {
		have[strings.ToLower(m[1])] = true
	}
	for _, want := range []string{"Why", "What Changes"} {
		if !have[strings.ToLower(want)] {
			r.add(file, 0, "missing section ## %s", want)
		}
	}
}

func delta(r *Report, path, livingDir string, rel func(string) string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	file := rel(path)
	capability := strings.TrimSuffix(filepath.Base(path), ".md")
	d := spec.ParseDelta(string(b))
	for _, p := range d.Problems {
		r.add(file, p.Line, "%s", p.Msg)
	}
	if d.Empty() && len(d.Problems) == 0 {
		r.add(file, 0, "no requirement: write at least one under ## ADDED, ## MODIFIED, ## REMOVED or ## RENAMED")
	}
	for _, req := range slices.Concat(d.Added, d.Modified) {
		requirement(r, file, req)
	}
	dup := dupes(r, file, d)
	livingPath := filepath.Join(livingDir, capability+".md")
	lb, err := os.ReadFile(livingPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if len(lb) == 0 {
		if d.Purpose != "" && len(strings.TrimSpace(comment.ReplaceAllString(d.Purpose, ""))) < MinPurpose {
			r.add(file, 0, "## Purpose is shorter than %d characters: write one or two sentences on what %s is for", MinPurpose, capability)
		}
	} else if d.Purpose != "" {
		r.add(file, 0, "%s already exists (%s): remove ## Purpose from the delta", capability, rel(livingPath))
	}
	if len(d.Problems) > 0 || dup {
		return nil
	}
	if _, err := spec.Merge(capability, string(lb), d); err != nil {
		me, ok := errors.AsType[*spec.MergeError](err)
		if !ok {
			return err
		}
		for _, p := range me.Problems {
			r.add(file, p.Line, "%s", p.Msg)
		}
	}
	return nil
}

func requirement(r *Report, file string, req spec.Requirement) {
	body := req.Text
	if i := strings.Index(body, "\n#### "); i >= 0 {
		body = body[:i]
	}
	if _, after, ok := strings.Cut(body, "\n"); ok {
		body = after
	} else {
		body = ""
	}
	if !shallMust.MatchString(comment.ReplaceAllString(body, "")) {
		r.add(file, req.Line, "requirement %q has no SHALL or MUST statement", req.Name)
	}
	if len(req.Scenarios) == 0 {
		r.add(file, req.Line, "requirement %q has no `#### Scenario:`", req.Name)
	}
	seen := map[string]int{}
	for _, s := range req.Scenarios {
		k := spec.Slug(s.Name)
		if first, ok := seen[k]; ok {
			r.add(file, s.Line, "scenario %q repeats the one on line %d", s.Name, first)
		}
		seen[k] = s.Line
	}
}

func dupes(r *Report, file string, d *spec.Delta) bool {
	seen := map[string]int{}
	found := false
	note := func(name string, line int) {
		k := spec.Key(name)
		if first, ok := seen[k]; ok {
			r.add(file, line, "requirement %q is named twice in this delta (first on line %d)", name, first)
			found = true
			return
		}
		seen[k] = line
	}
	for _, x := range slices.Concat(d.Added, d.Modified, d.Removed) {
		note(x.Name, x.Line)
	}
	for _, rn := range d.Renamed {
		note(rn.From, rn.Line)
	}
	return found
}

// Living validates every living spec in livingDir.
func Living(livingDir string, rel func(string) string) (*Report, error) {
	r := &Report{Target: "specs"}
	files, err := filepath.Glob(filepath.Join(livingDir, "*.md"))
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		file := rel(f)
		sp := spec.ParseLiving(string(b))
		for _, p := range sp.Problems {
			r.add(file, p.Line, "%s", p.Msg)
		}
		if len(strings.TrimSpace(sp.Purpose)) < MinPurpose {
			r.add(file, 0, "## Purpose is missing or shorter than %d characters", MinPurpose)
		}
		if len(sp.Requirements) == 0 {
			r.add(file, 0, "no requirements")
		}
		seen := map[string]int{}
		for _, req := range sp.Requirements {
			requirement(r, file, req)
			if first, ok := seen[spec.Key(req.Name)]; ok {
				r.add(file, req.Line, "requirement %q repeats the one on line %d", req.Name, first)
			}
			seen[spec.Key(req.Name)] = req.Line
		}
	}
	return r.done(), nil
}
