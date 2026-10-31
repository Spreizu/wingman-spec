package verify

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

func TestParseReview(t *testing.T) {
	st, d := parseReview("Looked at both viewports.\nSTATUS: pass\n- DEFECT: the price wraps at 360\nDEFECT:  the logo is cut  \nstatus: FAIL\n")
	if st != "fail" {
		t.Errorf("status = %q, want the last STATUS line (fail)", st)
	}
	if !slices.Equal(d, []string{"the price wraps at 360", "the logo is cut"}) {
		t.Errorf("defects = %q", d)
	}
	if st, d := parseReview("no verdict"); st != "" || len(d) != 0 || d == nil {
		t.Errorf("no STATUS: got %q %v (defects must be an empty list, not nil)", st, d)
	}
}

func TestFinishFindings(t *testing.T) {
	in := []Finding{
		{Source: "drift", Code: "b", Severity: "info", File: "a.js", Line: 1, Message: "x"},
		{Source: "lint", Code: "a", Severity: "warning", File: "b.js", Line: 9, Message: "y"},
		{Source: "lint", Code: "a", Severity: "error", File: "c.js", Line: 2, Message: "z"},
		{Source: "lint", Code: "a", Severity: "error", File: "b.js", Line: 5, Message: "z"},
		{Source: "lint", Code: "a", Severity: "error", File: "b.js", Line: 5, Message: "z"},
	}
	out := finishFindings(in)
	var got []string
	for _, f := range out {
		got = append(got, f.Severity+" "+f.File)
	}
	want := []string{"error b.js", "error c.js", "warning b.js", "info a.js"}
	if !slices.Equal(got, want) {
		t.Errorf("got %q, want %q (duplicates dropped, errors first, then file and line)", got, want)
	}
}

func TestDriftText(t *testing.T) {
	r := trace.DriftReport{
		Requirements: 3,
		Open: []trace.Gap{
			{Key: "unanchored-requirement:todo/add", Text: "no code anchor", Hint: "anchor it"},
			{Key: "stale-anchor:todo/rm@src/a.js", Text: "old", Severity: "info"},
		},
		Accepted: []trace.Gap{{Key: "untested-requirement:todo/list", Accepted: "legacy"}},
		Notes:    []string{"a note"},
		Observed: map[string]int{"entries": 1, "files": 1},
	}
	s := driftText(r)
	for _, w := range []string{
		"drift: 3 requirement(s); 1 open gap(s) (+1 advisory), 1 accepted",
		"  OPEN     unanchored-requirement:todo/add\n           no code anchor\n           hint: anchor it",
		"  INFO     stale-anchor:todo/rm@src/a.js  (advisory: does not fail drift)",
		"  note: a note",
		"1 open entry in 1 file(s)",
		"  accepted untested-requirement:todo/list  (legacy)",
	} {
		if !strings.Contains(s, w) {
			t.Errorf("missing %q in:\n%s", w, s)
		}
	}
}

func TestBatchTasks(t *testing.T) {
	dir := t.TempDir()
	g1, g2 := &tasks.Group{}, &tasks.Group{}
	ts := []taskRef{
		{T: &tasks.Task{Label: "1.1", Title: "a", Group: g1}},
		{T: &tasks.Task{Label: "1.2", Title: "b", Group: g1}},
		{T: &tasks.Task{Label: "1.R", Title: "Review", Group: g1}},
		{T: &tasks.Task{Label: "2.1", Title: "c", Group: g2}},
		{T: &tasks.Task{Label: "2.2", Title: "d", Group: g2}},
	}
	labels := func(b []taskRef) string {
		var l []string
		for _, t := range b {
			l = append(l, t.T.Label)
		}
		return strings.Join(l, ",")
	}
	size := func(s string) {
		body := "## Why\nx\n"
		if s != "" {
			body = "Size: " + s + "\n\n" + body
		}
		if err := os.WriteFile(filepath.Join(dir, "proposal.md"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := &Env{}
	for _, c := range []struct {
		size    string
		pending int
		perTask bool
		want    string
	}{
		{"", 0, false, "1.1"},      // no Size line: one task
		{"M", 0, false, "1.1,1.2"}, // a group, stopping at its review task
		{"M", 2, false, "1.R"},     // a review task goes alone
		{"M", 3, false, "2.1,2.2"}, // the next group
		{"S", 3, false, "2.1,2.2"}, // Size S: the rest of the change up to a review
		{"M", 0, true, "1.1"},      // --per-task
	} {
		size(c.size)
		e.O.PerTask = c.perTask
		if got := labels(e.batchTasks(dir, ts, c.pending)); got != c.want {
			t.Errorf("size %q pending %d perTask %v: got %s, want %s", c.size, c.pending, c.perTask, got, c.want)
		}
	}
	ts[1].Done = true
	size("S")
	e.O.PerTask = false
	if got := labels(e.batchTasks(dir, ts, 0)); got != "1.1" {
		t.Errorf("a done task ends the batch: got %s", got)
	}
}
