package runstate

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	out, err := c.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// While nothing is edited the working-tree hash is the hash of the committed tree.
func TestWorkTreeIsHeadTree(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	put(t, filepath.Join(dir, "src", "a.js"), "a\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "init")
	ForgetTrees()
	if got, want := Fingerprinted(dir, true).Tree, gitOut(t, dir, "rev-parse", "HEAD^{tree}"); got != want {
		t.Fatalf("tree %s, HEAD^{tree} %s", got, want)
	}
}

// The review range of an uncommitted change: an unreferenced snapshot commit parented on the base, holding the unstaged
// and staged edits and the untracked file but not the ignored file or the run state; nothing in the repository changes.
func TestReviewRange(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	put(t, filepath.Join(dir, "src", "a.js"), "a\n")
	put(t, filepath.Join(dir, "src", "b.js"), "b\n")
	put(t, filepath.Join(dir, ".gitignore"), "ignored.log\n.wingman-spec/runs/\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "base")
	base := gitOut(t, dir, "rev-parse", "HEAD")
	appendTo(t, filepath.Join(dir, "src", "a.js"))
	appendTo(t, filepath.Join(dir, "src", "b.js"))
	git(t, dir, "add", "src/b.js")
	put(t, filepath.Join(dir, "src", "new.js"), "new\n")
	put(t, filepath.Join(dir, "ignored.log"), "x\n")
	put(t, filepath.Join(dir, ".wingman-spec", "runs", "x", "state.json"), "x\n")
	snap := func() string {
		idx, _ := os.ReadFile(filepath.Join(dir, ".git", "index"))
		return strings.Join([]string{gitOut(t, dir, "log", "--oneline", "--all"), gitOut(t, dir, "rev-parse", "HEAD"),
			gitOut(t, dir, "status", "--porcelain"), gitOut(t, dir, "diff", "--cached"), gitOut(t, dir, "stash", "list"),
			gitOut(t, dir, "for-each-ref"), gitOut(t, dir, "branch"), string(idx)}, "\x00")
	}
	before := snap()
	r := ReviewRange(dir, base)
	if r == nil || r.Base != base || r.Head == "" || r.Head == base {
		t.Fatalf("range %+v, base %s", r, base)
	}
	if p := gitOut(t, dir, "rev-parse", r.Head+"^"); p != base {
		t.Fatalf("snapshot parent %s, want %s", p, base)
	}
	names := strings.Fields(gitOut(t, dir, "diff", "--name-only", r.Base, r.Head))
	slices.Sort(names)
	if strings.Join(names, " ") != "src/a.js src/b.js src/new.js" {
		t.Fatalf("diff names %v", names)
	}
	if snap() != before {
		t.Fatal("the repository changed")
	}
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "user")
	if n := len(strings.Fields(gitOut(t, dir, "diff", "--name-only", r.Base, r.Head))); n != 3 {
		t.Fatalf("after the user's commit the diff has %d files", n)
	}
	if r2 := ReviewRange(dir, strings.Repeat("0", 40)); r2 == nil || r2.Base != gitOut(t, dir, "rev-parse", "HEAD") {
		t.Fatalf("an unknown base does not fall back to HEAD: %+v", r2)
	}
}
