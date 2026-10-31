package runstate

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A same-size edit in the same second as the last index write is still seen: the index copy keeps the real index's
// mtime, so git's racy-entry check rehashes the file instead of trusting its stat data.
func TestSameSizeEditInTheIndexSecondChangesTheTree(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	file := filepath.Join(dir, "a.js")
	put(t, file, "module.exports = 2;\n")
	t0 := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(file, t0, t0); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "init")
	// The index was written in the same second as the file: its entry is racy.
	if err := os.Chtimes(filepath.Join(dir, ".git", "index"), t0, t0); err != nil {
		t.Fatal(err)
	}
	ForgetTrees()
	before := CacheTree(dir)
	put(t, file, "module.exports = 3;\n")
	if err := os.Chtimes(file, t0, t0); err != nil {
		t.Fatal(err)
	}
	ForgetTrees()
	if after := CacheTree(dir); after == before {
		t.Fatalf("same-size edit with an unchanged stat was not seen: tree %s", after)
	}
}
