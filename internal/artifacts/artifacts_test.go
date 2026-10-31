package artifacts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmbedded(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.IDs(), ","); got != "app-map,proposal,specs,design,adrs,tasks" {
		t.Errorf("ids = %s", got)
	}
	for _, a := range s.Artifacts {
		tpl, err := Template(a.Template)
		if err != nil || tpl == "" {
			t.Errorf("%s: template %s: %v", a.ID, a.Template, err)
		}
		for _, bad := range []string{"openspec", "verify-task", "skip_specs", "## ADDED Requirements"} {
			if strings.Contains(strings.ToLower(a.Instruction+tpl), strings.ToLower(bad)) {
				t.Errorf("%s still mentions %q", a.ID, bad)
			}
		}
	}
}

func TestStatus(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "proposal.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := MustLoad().Status(dir, false)
	want := map[string]string{"app-map": Ready, "proposal": Done, "specs": Ready, "design": Blocked, "tasks": Blocked}
	for _, a := range st.Artifacts {
		if w, ok := want[a.ID]; ok && a.Status != w {
			t.Errorf("%s = %s, want %s", a.ID, a.Status, w)
		}
	}
	if st.IsComplete {
		t.Error("complete")
	}
	if got := MustLoad().Status(dir, true).Artifacts[2].Status; got != Done {
		t.Errorf("specs with Specs: none = %s", got)
	}
}
