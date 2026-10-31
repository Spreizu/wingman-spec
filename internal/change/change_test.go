package change

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

func root(t *testing.T) *layout.Root {
	t.Helper()
	d := t.TempDir()
	if err := os.WriteFile(filepath.Join(d, layout.ConfigFile), []byte("context: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := layout.Find(d, "")
	if err != nil {
		t.Fatal(err)
	}
	return r
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

const delta = "## Purpose\nNotes keep short texts that a person writes down so they can read them later.\n\n## ADDED\n\n### Requirement: Save a note\nThe app SHALL save a note.\n\n#### Scenario: Saved\n- **WHEN** saved\n- **THEN** listed\n"

func TestLifecycle(t *testing.T) {
	r := root(t)
	dir, err := New(r, "add-notes")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(r, "add-notes"); err == nil {
		t.Error("second New: want an error")
	}
	if _, err := New(r, "Bad_Name"); err == nil {
		t.Error("bad name: want an error")
	}
	put(t, filepath.Join(dir, "proposal.md"), "Size: S\nRisk: none\n\n## Why\nx\n\n## What Changes\n- y\n")
	put(t, filepath.Join(dir, "specs", "notes.md"), delta)
	put(t, filepath.Join(dir, "tasks.md"), "## 1. Notes\n\n- [x] 1.1 Save\n- [ ] 1.2 List\n")
	put(t, filepath.Join(dir, "adrs", "store.md"), "---\ntitle: Store notes in a file\nstatus: Proposed\ndate: 2026-10-29\nchange: add-notes\n---\nBody\n")

	rep, err := Validate(r, "add-notes")
	if err != nil || !rep.Valid {
		t.Fatalf("validate: %v %+v", err, rep)
	}
	ls, _ := List(r)
	if len(ls) != 1 || ls[0].CompletedTasks != 1 || ls[0].TotalTasks != 2 || ls[0].Status != "in-progress" {
		t.Errorf("list = %+v", ls)
	}
	_, err = Archive(r, "add-notes", time.Now())
	if ref, ok := errors.AsType[*Refused](err); !ok || len(ref.Tasks) != 1 {
		t.Fatalf("archive with an open task: %v", err)
	}
	put(t, filepath.Join(dir, "tasks.md"), "## 1. Notes\n\n- [x] 1.1 Save\n")
	_, err = Archive(r, "add-notes", time.Now())
	if ref, ok := errors.AsType[*Refused](err); !ok || len(ref.Problems) != 2 {
		t.Fatalf("archive before sync: %v %+v", err, ref)
	}
	res, err := Sync(r, "add-notes", false)
	if err != nil || len(res.Problems) > 0 || res.Capabilities[0].Action != "created" || res.ADRs[0].File != "0001-store.md" {
		t.Fatalf("sync: %v %+v", err, res)
	}
	living, _ := os.ReadFile(filepath.Join(r.LivingSpecs(), "notes.md"))
	if !strings.HasPrefix(string(living), "# notes\n\n## Purpose\n") || !strings.Contains(string(living), "### Requirement: Save a note") {
		t.Errorf("living = %s", living)
	}
	if res, _ := Sync(r, "add-notes", false); res.Capabilities[0].Action != "unchanged" || res.ADRs[0].Action != "unchanged" {
		t.Errorf("second sync = %+v", res)
	}
	at := time.Date(2026, 10, 29, 14, 12, 0, 0, time.UTC)
	dst, err := Archive(r, "add-notes", at)
	if err != nil || filepath.Base(dst) != "2026-10-29-1412-add-notes" {
		t.Fatalf("archive: %v %s", err, dst)
	}
	if a, _ := Archived(r); len(a) != 1 {
		t.Errorf("archived = %v", a)
	}
}

func TestSyncConflictWritesNothing(t *testing.T) {
	r := root(t)
	dir, _ := New(r, "c")
	put(t, filepath.Join(dir, "specs", "a.md"), delta)
	put(t, filepath.Join(dir, "specs", "b.md"), "## MODIFIED\n\n### Requirement: Missing\nThe app SHALL x.\n\n#### Scenario: S\n- x\n")
	res, err := Sync(r, "c", false)
	if err != nil || len(res.Problems) != 1 {
		t.Fatalf("sync: %v %+v", err, res)
	}
	if _, err := os.Stat(filepath.Join(r.LivingSpecs(), "a.md")); err == nil {
		t.Error("a.md was written despite the conflict in b.md")
	}
}
