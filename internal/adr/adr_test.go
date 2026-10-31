package adr

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPromote(t *testing.T) {
	root := t.TempDir()
	ch, dir := filepath.Join(root, "changes", "c"), filepath.Join(root, "adrs")
	for name, body := range map[string]string{
		"use-db.md": "---\ntitle: Use a database\nstatus: Proposed\ndate: 2026-10-29\nchange: c\n---\n\n# Use a database\n",
		"none.md":   "No decision here.\n", // a none record by file name, no front matter
		"skip.md":   "---\ntitle: Skip\nstatus: None\ndate: 2026-10-25\n---\nNothing.\n",
	} {
		p := filepath.Join(ch, "adrs", name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if probs, _ := Check(ch, "c", dir); len(probs) != 1 || !strings.Contains(probs[0], "NOT PROMOTED") {
		t.Fatalf("check before = %v", probs)
	}
	res, err := Promote(ch, "c", dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 3 || res[0].Action != "skipped" || res[1].Action != "skipped" || res[2].File != "0001-use-db.md" || res[2].Action != "promoted" {
		t.Fatalf("results = %+v", res)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "0001-use-db.md"))
	if !strings.Contains(string(b), "status: Accepted\n") || !strings.Contains(string(b), "source: c/use-db\n") {
		t.Errorf("promoted = %s", b)
	}
	if res, _ := Promote(ch, "c", dir, false); res[2].Action != "unchanged" {
		t.Errorf("second run = %+v", res)
	}
	if probs, _ := Check(ch, "c", dir); len(probs) != 0 {
		t.Errorf("check after = %v", probs)
	}
	if _, err := os.Stat(filepath.Join(dir, "README.md")); err != nil {
		t.Error(err)
	}
}

func TestPlaceholderRefused(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "adrs", "x.md")
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte("---\ntitle: <!-- t -->\ndate: 2026-01-01\n---\n"), 0o644)
	if _, err := Promote(root, "c", filepath.Join(root, "out"), false); err == nil {
		t.Error("want an error for a placeholder title")
	}
}

func TestScalar(t *testing.T) {
	for in, want := range map[string]string{
		` "First"   # keep`: "First",
		` 'Second'`:         "Second",
		` One`:              "One",
		` Use C# here`:      "Use C# here",
		` Done # note`:      "Done",
		` "a # b"`:          "a # b",
		` <!-- fill in -->`: "<!-- fill in -->",
	} {
		if got := scalar(in); got != want {
			t.Errorf("scalar(%q) = %q, want %q", in, got, want)
		}
	}
}
