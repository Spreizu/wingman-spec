package trace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/spec"
)

// A result recorded at finish (the requirement read from the change's delta) stays current after archive (the same
// requirement read from the merged living spec): the spec fingerprint is of the requirement text, not of its file.
func TestSpecPrintSurvivesArchive(t *testing.T) {
	living := "## Purpose\nKeeps a list.\n\n## Requirements\n\n### Requirement: Add a todo\nThe system SHALL append a todo.\nWhy: A person wants a list, so that nothing is forgotten.\n\n#### Scenario: Added\n- **WHEN** x\n- **THEN** y\n"
	delta := "## ADDED\n\n### Requirement: Clear the list\nThe system SHALL remove every todo.\nWhy: A person wants a fresh start, so that old todos do not pile up.\n\n#### Scenario: Cleared\n- **WHEN** the user clears the list\n- **THEN** the list is empty\n\n## MODIFIED\n\n### Requirement: Add a todo\nThe system SHALL append a todo at the end.\nWhy: A person wants a list, so that nothing is forgotten.\n\n#### Scenario: Added\n- **WHEN** x\n- **THEN** y\n"
	specs, change := t.TempDir(), t.TempDir()
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(specs, "todo.md"), living)
	write(filepath.Join(change, "specs", "todo.md"), delta)
	before := Effective(specs, change)
	merged, err := spec.Merge("todo", living, spec.ParseDelta(delta), nil)
	if err != nil {
		t.Fatal(err)
	}
	after := t.TempDir()
	write(filepath.Join(after, "todo.md"), merged)
	got := Living(after)
	for _, k := range []string{"todo/add-a-todo", "todo/clear-the-list"} {
		b, _ := before.Get(k)
		a, ok := got.Get(k)
		if !ok || specPrint(a) != specPrint(b) {
			t.Errorf("%s: the fingerprint changed at archive:\n%q\n%q", k, b.Block, a.Block)
		}
	}
}
