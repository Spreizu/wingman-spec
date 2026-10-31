package anchors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A replaced anchored unit is reported: the unit was edited, not just unmarked (findings must reach the result).
func TestGuardReplacedUnitIsReported(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "login.js")
	base := "/**\n * Logs a user in.\n * @spec auth/user-login\n */\nexport function login(email, password) {\n  return session(find(email));\n}\n"
	if err := os.WriteFile(f, []byte(base), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "base")
	cur := "// @spec auth/user-login\nexport function other() {\n  return 1;\n}\n"
	if err := os.WriteFile(f, []byte(cur), 0o644); err != nil {
		t.Fatal(err)
	}
	r := Guard(GuardOpts{CodeRoot: dir, Base: "HEAD", Listed: map[string]bool{}, Reviewed: map[string]bool{}})
	if len(r.Findings) != 1 || r.Findings[0].Kind != "anchor-touched-unlisted" {
		t.Fatalf("findings = %+v, want one anchor-touched-unlisted", r.Findings)
	}
	if !r.Touched["auth/user-login"] || len(r.Files) != 1 {
		t.Fatalf("touched=%v files=%v", r.Touched, r.Files)
	}
	r = Guard(GuardOpts{CodeRoot: dir, Base: "HEAD", Listed: map[string]bool{"auth/user-login": true}})
	if len(r.Findings) != 0 {
		t.Fatalf("listed requirement still reported: %+v", r.Findings)
	}
}

// A marker added in a file the task's Files: line does not list is reported; a listed directory covers its files.
func TestGuardOutsideTaskFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	util := filepath.Join(dir, "src", "util.js")
	if err := os.WriteFile(util, []byte("export function unrelated(a) {\n  return a * 2;\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "base")
	if err := os.WriteFile(util, []byte("// @spec todo/add-a-todo\nexport function unrelated(a) {\n  return a * 2;\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{"todo/add-a-todo": true}
	kinds := func(files ...string) string {
		var ks []string
		for _, f := range Guard(GuardOpts{CodeRoot: dir, Base: "HEAD", Listed: listed, TaskFiles: files}).Findings {
			ks = append(ks, f.Kind)
		}
		return strings.Join(ks, ",")
	}
	if got := kinds("src/todo.js"); got != "anchor-outside-task-files" {
		t.Errorf("outside Files: got %q", got)
	}
	if got := kinds("src/"); got != "" {
		t.Errorf("inside a listed directory: got %q", got)
	}
}
