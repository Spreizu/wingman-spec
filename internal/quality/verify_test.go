package quality

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestVerifyMethod(t *testing.T) {
	for in, want := range map[string]string{"inspection": "inspection", "**Analysis** of the logs": "analysis", "Demonstration.": "demonstration", "test": "", "": ""} {
		if got := VerifyMethod(in); got != want {
			t.Errorf("VerifyMethod(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTraceCountsVerifiedScenarios(t *testing.T) {
	dir := t.TempDir()
	spec := "## ADDED\n\n### Requirement: Manual\nThe manual SHALL list every flag.\nVerify: inspection of the manual\n\n#### Scenario: Read it\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Code\nThe code SHALL do x.\n\n#### Scenario: Do it\n- **WHEN** x\n- **THEN** y\n"
	if err := os.WriteFile(filepath.Join(dir, "docs.md"), []byte(spec), 0o644); err != nil {
		t.Fatal(err)
	}
	r := Trace(SpecScenarios(dir), map[string][]string{}, true)
	if !slices.Equal(r.Verified, []string{"docs/read-it"}) || len(r.Missing) != 1 || r.Missing[0].ID != "docs/do-it" {
		t.Fatalf("verified %v, missing %v", r.Verified, r.Missing)
	}
}
