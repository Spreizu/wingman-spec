package greenfield

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

func put(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A specs repository counts the code of the repos that share it, and a linked code repo may adopt.
func TestModeWithSpecsRepo(t *testing.T) {
	base := t.TempDir()
	specs := filepath.Join(base, "specs")
	put(t, filepath.Join(specs, layout.ConfigFile), "context: x\n")
	put(t, filepath.Join(base, "web", layout.Dir, layout.ConfigFile), "specs: ../specs\n")
	find := func(dir string) *Project {
		r, err := layout.Find(dir, "")
		if err != nil {
			t.Fatal(err)
		}
		return New(r)
	}
	if m := find(specs).ModeOf(); m.Mode != Greenfield {
		t.Fatalf("no code anywhere: %s, want greenfield", m.Mode)
	}
	put(t, filepath.Join(base, "web", "src", "app.ts"), strings.Repeat("export const a = 1;\n", 40))
	m := find(specs).ModeOf()
	if m.Mode != Brownfield || len(m.CodeRepos) != 1 || m.CodeRepos[0] != "../web" || !strings.Contains(m.Signals[0].Detail, "../web/src/app.ts") {
		t.Fatalf("specs repo with a linked code repo: %+v, want brownfield from ../web", m)
	}
	if Allowed(find(specs).ModeFor("start").Mode, "start") {
		t.Fatal("greenfield start must refuse once a linked repo has code")
	}
	web := find(filepath.Join(base, "web"))
	if m := web.ModeFor("adopt"); !Allowed(m.Mode, "adopt") {
		t.Fatalf("linked code repo: adopt refused in mode %s", m.Mode)
	}
	for _, c := range []string{"start", "plan", "next", "status"} {
		if m := web.ModeFor(c); m.Mode != Unsupported {
			t.Fatalf("linked code repo: %s sees %s, want unsupported", c, m.Mode)
		}
	}
}
