package quality

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixAddsWhyAndPurpose(t *testing.T) {
	dir := t.TempDir()
	specs := filepath.Join(dir, "specs")
	if err := os.MkdirAll(specs, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "# Billing\n\n## ADDED\n\n### Requirement: Invoices\nThe system SHALL list invoices.\n\n#### Scenario: List\n- **WHEN** the page opens\n- **THEN** the list shows 3 rows\n"
	if err := os.WriteFile(filepath.Join(specs, "billing.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	n, err := Fix(dir)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("fixes %d", n)
	}
	got, _ := os.ReadFile(filepath.Join(specs, "billing.md"))
	s := string(got)
	if !strings.Contains(s, "## Purpose") || !strings.Contains(s, "Why: <fill in>") {
		t.Fatalf("got:\n%s", s)
	}
}
