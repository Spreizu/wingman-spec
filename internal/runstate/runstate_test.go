package runstate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid")
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func put(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendTo(t *testing.T, path string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("y\n")
	_ = f.Close()
}

// The cache hash: memoised per process and forgotten after a command; an edit of an untracked or a tracked file changes
// it, an ignored file does not; untracked files add a name, size and mtime signature; the real index is untouched.
func TestCacheTree(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	put(t, filepath.Join(dir, ".gitignore"), "node_modules/\n")
	put(t, filepath.Join(dir, "src", "a.js"), "x\n")
	put(t, filepath.Join(dir, "node_modules", "p", "i.js"), "x\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "init")
	put(t, filepath.Join(dir, "data", "w0"), "x\n")
	index := filepath.Join(dir, ".git", "index")
	before, _ := os.ReadFile(index)
	changes := func(file string) bool {
		ForgetTrees()
		a, b := CacheTree(dir), CacheTree(dir)
		if a != b {
			t.Fatalf("memoised hash differs: %s %s", a, b)
		}
		appendTo(t, filepath.Join(dir, file))
		ForgetTrees()
		return CacheTree(dir) != a
	}
	if !changes("data/w0") {
		t.Error("an edit of an untracked file should change the hash")
	}
	if !changes("src/a.js") {
		t.Error("an edit of a tracked file should change the hash")
	}
	if changes("node_modules/p/i.js") {
		t.Error("an ignored file should not change the hash")
	}
	if !strings.Contains(CacheTree(dir), "+") {
		t.Error("untracked files should add a signature to the hash")
	}
	if after, _ := os.ReadFile(index); string(after) != string(before) {
		t.Error("the real index changed")
	}
}
