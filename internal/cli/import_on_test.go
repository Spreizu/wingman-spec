//go:build importer

package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportOpenSpec(t *testing.T) {
	for _, c := range []struct{ to, kind, specs string }{
		{"", "in-repo", ".wingman-spec/specs/a.md"},
		{".", "specs-repo", "specs/a.md"},
	} {
		dir := t.TempDir()
		put(t, filepath.Join(dir, "openspec", "config.yaml"), "schema: wingman-spec\ncontext: |\n  - Test command: `npm test`\n")
		put(t, filepath.Join(dir, "openspec", "specs", "a", "spec.md"), "# a\n\n## Purpose\nx\n\n## Requirements\n")
		args := []string{"import", "openspec"}
		if c.to != "" {
			args = append(args, "--to", c.to)
		}
		if r := run(t, dir, args...); r.code != 0 {
			t.Fatalf("import --to %q = %+v", c.to, r)
		}
		if _, err := os.Stat(filepath.Join(dir, c.specs)); err != nil {
			t.Errorf("--to %q: %v", c.to, err)
		}
		r := run(t, dir, "root", "--json")
		var root struct{ Kind string }
		if err := json.Unmarshal([]byte(r.out), &root); err != nil || root.Kind != c.kind {
			t.Errorf("--to %q: root = %v %+v", c.to, err, r)
		}
		if r := run(t, dir, "config", "--json"); !strings.Contains(r.out, "npm test") {
			t.Errorf("--to %q: the test command was not carried over: %+v", c.to, r)
		}
	}
}
