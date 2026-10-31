package validate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodProposal = "Size: S\nRisk: none\n\n## Why\nPeople lose notes.\n\n## What Changes\n- Notes are saved.\n"

const living = `# notes

## Purpose
Notes keep short texts that a person writes down so they can read them later.

## Requirements

### Requirement: Save a note
The app SHALL save a note.

#### Scenario: Saved
- **WHEN** a note is saved
- **THEN** it is listed
`

func write(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func run(t *testing.T, files map[string]string) *Report {
	t.Helper()
	root := t.TempDir()
	write(t, root, files)
	rel := func(p string) string { r, _ := filepath.Rel(root, p); return r }
	r, err := Change(filepath.Join(root, "changes", "c"), filepath.Join(root, "specs"), rel)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func messages(r *Report) string {
	var b strings.Builder
	for _, i := range r.Issues {
		b.WriteString(i.String() + "\n")
	}
	return b.String()
}

func TestChange(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
		want  string // "" = valid
	}{
		{"valid modified", map[string]string{"changes/c/proposal.md": goodProposal, "specs/notes.md": living,
			"changes/c/specs/notes.md": "## MODIFIED\n\n### Requirement: Save a note\nThe app SHALL save a note with a title.\n\n#### Scenario: Saved\n- **WHEN** x\n- **THEN** y\n"}, ""},
		{"valid new capability", map[string]string{"changes/c/proposal.md": goodProposal,
			"changes/c/specs/tags.md": "## Purpose\nTags group notes so a person can find related notes again quickly.\n\n## ADDED\n\n### Requirement: Tag a note\nThe app MUST tag.\n\n#### Scenario: Tagged\n- x\n"}, ""},
		{"specs none", map[string]string{"changes/c/proposal.md": goodProposal + "Specs: none\n"}, ""},
		{"no specs", map[string]string{"changes/c/proposal.md": goodProposal}, "no delta specs"},
		{"missing why", map[string]string{"changes/c/proposal.md": "## What Changes\n", "changes/c/specs/notes.md": "x"}, "missing section ## Why"},
		{"no shall", map[string]string{"changes/c/proposal.md": goodProposal, "specs/notes.md": living,
			"changes/c/specs/notes.md": "## ADDED\n\n### Requirement: Delete\nThe app deletes.\n\n#### Scenario: Gone\n- x\n"}, "no SHALL or MUST"},
		{"no scenario", map[string]string{"changes/c/proposal.md": goodProposal, "specs/notes.md": living,
			"changes/c/specs/notes.md": "## ADDED\n\n### Requirement: Delete\nThe app SHALL delete.\n\n### Scenario: Gone\n- x\n"}, "Scenario"},
		{"conflict", map[string]string{"changes/c/proposal.md": goodProposal, "specs/notes.md": living,
			"changes/c/specs/notes.md": "## ADDED\n\n### Requirement: Save a note\nThe app SHALL save.\n\n#### Scenario: S\n- x\n"}, "already exists"},
		{"short purpose", map[string]string{"changes/c/proposal.md": goodProposal,
			"changes/c/specs/tags.md": "## Purpose\nTags.\n\n## ADDED\n\n### Requirement: Tag\nThe app SHALL tag.\n\n#### Scenario: T\n- x\n"}, "shorter than"},
		{"legacy heading", map[string]string{"changes/c/proposal.md": goodProposal, "specs/notes.md": living,
			"changes/c/specs/notes.md": "## ADDED Requirements\n\n### Requirement: Tag\nThe app SHALL tag.\n\n#### Scenario: T\n- x\n"}, "import openspec"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := run(t, tt.files)
			got := messages(r)
			if tt.want == "" {
				if !r.Valid {
					t.Errorf("want valid, got:\n%s", got)
				}
				return
			}
			if r.Valid || !strings.Contains(got, tt.want) {
				t.Errorf("want an error containing %q, got valid=%v:\n%s", tt.want, r.Valid, got)
			}
		})
	}
}

func TestLiving(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{"notes.md": living, "bad.md": "# bad\n\n## Purpose\nShort.\n\n## Requirements\n"})
	r, err := Living(root, filepath.Base)
	if err != nil {
		t.Fatal(err)
	}
	got := messages(r)
	if r.Valid || !strings.Contains(got, "bad.md: ## Purpose") || strings.Contains(got, "notes.md") {
		t.Errorf("got:\n%s", got)
	}
}
