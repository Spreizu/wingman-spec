package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type result struct {
	code     int
	out, err string
}

func run(t *testing.T, dir string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	code := RunIn(dir, args, &out, &errb)
	return result{code, out.String(), errb.String()}
}

func put(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWorkflow(t *testing.T) {
	dir := t.TempDir()
	if r := run(t, dir, "list"); r.code != ExitUsage || !strings.Contains(r.err, "wingman-spec init") {
		t.Fatalf("list before init = %+v", r)
	}
	if r := run(t, dir, "init"); r.code != 0 {
		t.Fatalf("init = %+v", r)
	}
	cfgFile := filepath.Join(dir, ".wingman-spec", "wingman-spec.yaml")
	b, err := os.ReadFile(cfgFile)
	if err != nil {
		t.Fatal(err)
	}
	put(t, cfgFile, strings.Replace(string(b), "traceability: on", "traceability: off", 1))
	if r := run(t, dir, "new", "add-notes"); r.code != 0 {
		t.Fatalf("new = %+v", r)
	}
	ch := filepath.Join(dir, ".wingman-spec", "changes", "add-notes")
	r := run(t, dir, "status", "add-notes", "--json")
	var st struct {
		Artifacts []struct{ ID, Status string } `json:"artifacts"`
	}
	if err := json.Unmarshal([]byte(r.out), &st); err != nil || st.Artifacts[1].Status != "ready" {
		t.Fatalf("status = %v %+v", err, r)
	}
	if r := run(t, dir, "instructions", "specs", "add-notes"); r.code != 0 || !strings.Contains(r.out, "## ADDED") {
		t.Fatalf("instructions = %+v", r)
	}
	if r := run(t, dir, "instructions", "nope", "add-notes"); r.code != ExitUsage {
		t.Errorf("unknown artifact = %+v", r)
	}
	put(t, filepath.Join(ch, "proposal.md"), "Size: S\nRisk: none\n\n## Why\nx\n\n## What Changes\n- y\n")
	if r := run(t, dir, "validate", "add-notes"); r.code != ExitFail || !strings.Contains(r.out, "no delta specs") {
		t.Fatalf("validate without specs = %+v", r)
	}
	put(t, filepath.Join(ch, "specs", "notes.md"), "## Purpose\nNotes keep short texts that a person writes down so they can read them later.\n\n## ADDED\n\n### Requirement: Save a note\nThe app SHALL save a note.\n\n#### Scenario: Saved\n- **WHEN** saved\n- **THEN** listed\n")
	put(t, filepath.Join(ch, "tasks.md"), "## 1. Notes\n\n- [x] 1.1 Save\n")
	if r := run(t, dir, "validate", "add-notes"); r.code != 0 {
		t.Fatalf("validate = %+v", r)
	}
	if r := run(t, dir, "sync", "add-notes", "--check"); r.code != ExitFail {
		t.Errorf("sync --check before = %+v", r)
	}
	if r := run(t, dir, "archive", "add-notes"); r.code != ExitFail || !strings.Contains(r.err, "finish: finish has not passed") || !strings.Contains(r.err, "lint: ") {
		t.Errorf("archive before finish = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, ".wingman-spec", "specs", "notes.md")); err == nil {
		t.Fatal("a refused archive wrote the living spec")
	}
	// a spec-only change has no code to finish; the rest of the gate still holds
	put(t, cfgFile, strings.Replace(strings.Replace(string(b), "traceability: on", "traceability: off", 1), "test: <fill in>", "test: none", 1))
	put(t, filepath.Join(ch, "proposal.md"), "Size: S\nRisk: none\nKind: spec-only\n\n## Why\nx\n\n## What Changes\n- y\n\n## Edge cases\n- none named\n")
	put(t, filepath.Join(ch, "tasks.md"), "## 1. Notes\n\n- [x] 1.1 Save\n  - Files: .wingman-spec/changes/add-notes/specs/notes.md\n")
	if r := run(t, dir, "sync", "add-notes"); r.code != 0 || !strings.Contains(r.out, "created") {
		t.Fatalf("sync = %+v", r)
	}
	if r := run(t, dir, "validate", "--specs"); r.code != 0 {
		t.Errorf("validate --specs = %+v", r)
	}
	put(t, filepath.Join(ch, "BLOCKED.md"), "x")
	if r := run(t, dir, "archive", "add-notes"); r.code != ExitBlocked {
		t.Errorf("archive blocked = %+v", r)
	}
	_ = os.Remove(filepath.Join(ch, "BLOCKED.md"))
	if r := run(t, dir, "archive", "add-notes", "--json"); r.code != 0 || !strings.Contains(r.out, `"archived"`) {
		t.Fatalf("archive = %+v", r)
	}
	if r := run(t, dir, "list", "--archived"); !strings.Contains(r.out, "-add-notes") {
		t.Errorf("list --archived = %+v", r)
	}
	if r := run(t, dir, "bogus"); r.code != ExitUsage {
		t.Errorf("bogus = %+v", r)
	}
}

// doctor lists each config problem on its own line, naming the file, the line and the fix.
func TestDoctorConfigProblems(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, ".wingman-spec", "wingman-spec.yaml"), "commands:\n  test: a\n  test: b\nvisual:\n  url: x\n  url: y\n")
	r := run(t, dir, "doctor", "--json")
	var j struct{ Problems []string }
	if err := json.Unmarshal([]byte(r.out), &j); err != nil || r.code == 0 || len(j.Problems) != 2 ||
		!strings.HasSuffix(j.Problems[0], "wingman-spec.yaml: line 3: commands.test is written twice (first at line 2); keep one and delete the other") {
		t.Errorf("doctor = %v %+v", err, r)
	}
}

func TestTimelineRecordsPlanningAndLog(t *testing.T) {
	dir := t.TempDir()
	run(t, dir, "init")
	run(t, dir, "new", "tl")
	if r := run(t, dir, "log", "tl", "explore", "asked about blocked firms"); r.code != 0 {
		t.Fatalf("log = %+v", r)
	}
	if r := run(t, dir, "log", "tl", "bogus"); r.code != ExitUsage {
		t.Fatalf("log bogus = %+v", r)
	}
	put(t, filepath.Join(dir, ".wingman-spec", "changes", "tl", "proposal.md"), "# P\n")
	t.Setenv(SourceEnv, "editor")
	run(t, dir, "validate", "tl")
	run(t, dir, "status", "tl")
	run(t, dir, "list") // not recorded
	tl := filepath.Join(dir, ".wingman-spec", "runs", "tl", "timeline.jsonl")
	b, err := os.ReadFile(tl)
	if err != nil {
		t.Fatal(err)
	}
	var evs []string
	for l := range strings.SplitSeq(strings.TrimSpace(string(b)), "\n") {
		var e struct{ Event, Summary string }
		_ = json.Unmarshal([]byte(l), &e)
		evs = append(evs, e.Event+":"+e.Summary)
	}
	got := strings.Join(evs, " | ")
	want := "new:change created | explore:asked about blocked firms | artifact:wrote proposal.md | validate:"
	if !strings.HasPrefix(got, want) || !strings.HasSuffix(got, "| status:status") || !strings.Contains(string(b), `"source":"editor"`) {
		t.Fatalf("timeline = %s", got)
	}
	// An edited entry: validate warns (and stays valid), doctor names it.
	put(t, tl, strings.Replace(string(b), "asked about", "never asked", 1))
	r := run(t, dir, "validate", "tl")
	if !strings.Contains(r.out, "the timeline was changed after it was written: entry 3") {
		t.Fatalf("validate = %+v", r)
	}
}

// progress appends checked entries to progress.md, in the lines the review proof and the anchor guard read, and records each.
func TestProgress(t *testing.T) {
	dir := t.TempDir()
	run(t, dir, "init")
	run(t, dir, "new", "pg")
	ch := filepath.Join(dir, ".wingman-spec", "changes", "pg")
	put(t, filepath.Join(ch, "tasks.md"), "## 1. Notes\n- [ ] 1.1 Add a note\n- [ ] 1.R Request code review\n")
	for _, bad := range [][]string{
		{"--task", "9.9", "--note", "x"},                                // no such task
		{"--task", "1.1", "--note", ""},                                 // empty note
		{"--task", "1.1", "--note", "two\nlines"},                       // not one line
		{"--task", "1.1", "--review-fix", "empty-title", "--note", "x"}, // not a review task
		{"--task", "1.R", "--review-fix", "Bad Slug", "--note", "x"},
		{"--task", "1.1", "--status", "finished", "--note", "x"},
		{"--task", "1.1", "--untestable", "why", "--note", "x"},
		{"--reviewed-anchor", "notes", "--note", "x"},
	} {
		if r := run(t, dir, append([]string{"progress", "pg"}, bad...)...); r.code != ExitUsage {
			t.Fatalf("progress %q = %+v, want a usage error", bad, r)
		}
	}
	for _, ok := range [][]string{
		{"--task", "1.1", "--note", "the note form posts to /notes"},
		{"--task", "1.1", "--status", "blocked", "--note", "waiting for the notes table"},
		{"--task", "1.R", "--review-fix", "empty-title", "--note", "an empty title was saved"},
		{"--task", "1.R", "--review-fix", "slow-list", "--untestable", "needs 10k rows", "--note", "the list loaded every note"},
		{"--reviewed-anchor", "notes/list-notes", "--note", "only the query changed"},
	} {
		if r := run(t, dir, append([]string{"progress", "pg"}, ok...)...); r.code != 0 {
			t.Fatalf("progress %q = %+v", ok, r)
		}
	}
	if r := run(t, dir, "progress", "pg", "--task", "1.R", "--review-fix", "empty-title", "--untestable", "a race", "--note", "an empty title was saved"); r.code != 0 {
		t.Fatalf("a review fix recorded again = %+v", r)
	}
	b, _ := os.ReadFile(filepath.Join(ch, "progress.md"))
	want := "# Progress: pg\n\n## 1.1 Add a note\n\n- the note form posts to /notes\n- waiting for the notes table (blocked)\n" +
		"\n## 1.R Request code review\n\n- Review fix: empty-title - an empty title was saved - untestable: a race\n" +
		"- Review fix: slow-list - the list loaded every note - untestable: needs 10k rows\n" +
		"\n## Change\n\n- Reviewed anchors: notes/list-notes - only the query changed\n"
	if string(b) != want {
		t.Fatalf("progress.md =\n%s\nwant\n%s", b, want)
	}
	tl, _ := os.ReadFile(filepath.Join(dir, ".wingman-spec", "runs", "pg", "timeline.jsonl"))
	var got []string
	for l := range strings.SplitSeq(strings.TrimSpace(string(tl)), "\n") {
		var e struct{ Event, Task, Summary string }
		_ = json.Unmarshal([]byte(l), &e)
		if e.Event == "progress" {
			got = append(got, e.Task+"|"+e.Summary)
		}
	}
	if len(got) != 6 || got[0] != "1.1|the note form posts to /notes" || got[3] != "1.R|Review fix slow-list: the list loaded every note (untestable: needs 10k rows)" || got[5] != "1.R|Review fix empty-title: an empty title was saved (untestable: a race) (replaces the earlier entry)" || got[4] != "|Reviewed anchor notes/list-notes: only the query changed" {
		t.Fatalf("progress events = %q", got)
	}
}
