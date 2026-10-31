package scaffold

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/layout"
)

func TestInitLayouts(t *testing.T) {
	ws := t.TempDir()
	specs, code, repo := filepath.Join(ws, "specs"), filepath.Join(ws, "web"), filepath.Join(ws, "app")
	for _, c := range []struct {
		dir string
		o   Options
		k   layout.Kind
	}{
		{repo, Options{Layout: Repo}, layout.InRepo},
		{specs, Options{Layout: Specs}, layout.SpecsRepo},
		{code, Options{Layout: Link, SpecsPath: "../specs"}, layout.Linked},
	} {
		_ = os.MkdirAll(c.dir, 0o755)
		wrote, err := Init(c.dir, c.o)
		if err != nil || len(wrote) == 0 {
			t.Fatalf("%s: %v %v", c.o.Layout, err, wrote)
		}
		r, err := layout.Find(c.dir, "")
		if err != nil || r.Kind != c.k {
			t.Fatalf("%s: find = %v %+v", c.o.Layout, err, r)
		}
		cfg, err := config.Load(r.Configs...)
		if err != nil {
			t.Fatalf("%s: config: %v", c.o.Layout, err)
		}
		if cfg.Commands.Test != config.Placeholder {
			t.Errorf("%s: test = %q", c.o.Layout, cfg.Commands.Test)
		}
		if r.Kind == layout.SpecsRepo {
			// The run state sits in the specs root of a specs repository, so that folder must ignore itself.
			if b, err := os.ReadFile(filepath.Join(filepath.Dir(r.Runs("x")), ".gitignore")); err != nil || string(b) != "*\n" {
				t.Errorf("specs layout: runs/.gitignore = %q %v", b, err)
			}
		}
		if again, _ := Init(c.dir, c.o); len(again) != 0 {
			t.Errorf("%s: second init wrote %v", c.o.Layout, again)
		}
	}
}
