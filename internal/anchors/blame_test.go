package anchors

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid")
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func jsonFiles(t *testing.T, dir string) int {
	t.Helper()
	es, _ := os.ReadDir(dir)
	n := 0
	for _, e := range es {
		if strings.HasSuffix(e.Name(), ".json") {
			n++
		}
	}
	return n
}

// The blame cache lives in the git directory, is reused while HEAD and the content stay, and never serves a stale answer.
func TestBlameCache(t *testing.T) {
	t.Setenv("WINGMAN_SPEC_NO_CACHE", "")
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	file := filepath.Join(dir, "a.js")
	if err := os.WriteFile(file, []byte("module.exports = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "one")
	cacheDir := filepath.Join(dir, ".git", "wingman-blame-cache")
	fresh := func() []string { // one process per CLI run: forget the memoized dir
		blameDirs.Delete(dir)
		b := blameOf(dir, "a.js", false)
		if b == nil {
			t.Fatal("no blame")
		}
		return b.PerLine
	}
	b1 := fresh()
	if jsonFiles(t, cacheDir) != 1 || git(t, dir, "status", "--porcelain") != "" {
		t.Fatal("the first blame should be stored in the git directory only")
	}
	if b2 := fresh(); !slices.Equal(b1, b2) || jsonFiles(t, cacheDir) != 1 {
		t.Fatal("the second answer should be the same, with nothing new stored")
	}
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString("module.exports = 6;\n")
	_ = f.Close()
	if b3 := fresh(); slices.Equal(b3, b1) || !strings.HasPrefix(b3[len(b3)-1], "0000000") {
		t.Fatalf("an uncommitted edit should be blamed fresh, got %v", b3)
	}
	git(t, dir, "commit", "-qam", "edit")
	head := git(t, dir, "rev-parse", "HEAD")
	b4 := fresh()
	if h, _ := os.ReadFile(filepath.Join(cacheDir, "HEAD")); string(h) != head || jsonFiles(t, cacheDir) != 1 || b4[len(b4)-1] != head {
		t.Fatalf("after a commit the cache should be emptied and the new commit blamed, got %v", b4)
	}
}
