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
	n, err := Fix(dir, filepath.Join(dir, "none"))
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

func TestFixPurposeOnlyForNewCapability(t *testing.T) {
	delta := "## ADDED\n\n### Requirement: Invoices\nThe system SHALL list invoices.\nWhy: x, so that y.\n"
	if got, n := fixSpec(delta, false); n != 0 || got != delta {
		t.Fatalf("a living capability's delta got a fix (%d):\n%s", n, got)
	}
	if got, _ := fixSpec(delta, true); !strings.HasPrefix(got, "## Purpose\n<fill in>\n\n## ADDED\n") {
		t.Fatalf("Purpose must come before the first section:\n%s", got)
	}
}
