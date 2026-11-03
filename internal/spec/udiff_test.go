package spec

import "testing"

func TestUnified(t *testing.T) {
	if Unified("a.md", "same\n", "same\n") != "" {
		t.Fatal("equal texts need no diff")
	}
	d := Unified("a.md", "old\n", "new\n")
	if d == "" || d[:4] != "--- " {
		t.Fatalf("diff %q", d)
	}
}
