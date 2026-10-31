package trace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Accepted line of a living requirement is read as the accepted reason and is not part of the requirement text
// (sync compares the text, so accepting a gap never makes a requirement look changed).
func TestAcceptedLineIsNotRequirementText(t *testing.T) {
	dir := t.TempDir()
	spec := "## Purpose\nKeeps a list.\n\n## Requirements\n\n### Requirement: Add a todo\nThe system SHALL append a todo.\nAccepted: new reason\nWhy: A person wants to keep a list, so that nothing is forgotten.\n\n#### Scenario: Add\n- **WHEN** x\n- **THEN** y\n"
	if err := os.WriteFile(filepath.Join(dir, "todo.md"), []byte(spec), 0o644); err != nil {
		t.Fatal(err)
	}
	r, ok := Living(dir).Get("todo/add-a-todo")
	if !ok {
		t.Fatal("todo/add-a-todo not found")
	}
	if r.Accepted == nil || *r.Accepted != "new reason" {
		t.Fatalf("accepted = %v", r.Accepted)
	}
	if strings.Contains(r.Block, "Accepted") {
		t.Fatalf("block keeps the Accepted line: %q", r.Block)
	}
}
