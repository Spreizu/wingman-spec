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
	if r := run(t, dir, "archive", "add-notes"); r.code != ExitFail || !strings.Contains(r.err, "NOT SYNCED") {
		t.Errorf("archive before sync = %+v", r)
	}
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

func TestImportOpenSpec(t *testing.T) {
	for _, c := range []struct{ to, kind, specs string }{
		{"", "in-repo", ".wingman-spec/specs/a.md"},
		{".", "specs-repo", "specs/a.md"},
	} {
		dir := t.TempDir()
		put(t, filepath.Join(dir, "openspec", "config.yaml"), "schema: wingman-spec\ncontext: |\n  - Test command: `npm test`\n")
		put(t, filepath.Join(dir, "openspec", "specs", "a", "spec.md"), "# a\n\n## Purpose\nx\n\n## Requirements\n")
		args := []string{"import", "openspec"}
		if c.to != "" {
			args = append(args, "--to", c.to)
		}
		if r := run(t, dir, args...); r.code != 0 {
			t.Fatalf("import --to %q = %+v", c.to, r)
		}
		if _, err := os.Stat(filepath.Join(dir, c.specs)); err != nil {
			t.Errorf("--to %q: %v", c.to, err)
		}
		r := run(t, dir, "root", "--json")
		var root struct{ Kind string }
		if err := json.Unmarshal([]byte(r.out), &root); err != nil || root.Kind != c.kind {
			t.Errorf("--to %q: root = %v %+v", c.to, err, r)
		}
		if r := run(t, dir, "config", "--json"); !strings.Contains(r.out, "npm test") {
			t.Errorf("--to %q: the test command was not carried over: %+v", c.to, r)
		}
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
