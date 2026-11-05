package verify

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
)

// The finish event carries what the editor's run summary shows: each check's verdict, and the code files changed since
// the run's base commit with their added and removed lines. Both are taken when finish runs, so the summary stays the
// same however the tree changes later.

// finishChecks keeps the name, verdict, skip reason and untested scenarios of finish's checks, in their order.
func finishChecks(v any) []map[string]any {
	xs, _ := v.([]any)
	var out []map[string]any
	for _, a := range xs {
		x, _ := a.(*Obj)
		if x == nil {
			continue
		}
		name, _ := x.Get("check").(string)
		if name == "" {
			continue
		}
		ok, _ := x.Get("ok").(bool)
		c := map[string]any{"name": name, "ok": ok}
		if s, _ := x.Get("skipped").(string); s != "" {
			c["skipped"] = s
		}
		if u := strs(x.Get("untested")); len(u) > 0 {
			c["untested"] = u
		}
		out = append(out, c)
	}
	return out
}

// maxDiffFiles caps the files listed; the totals count every file.
const maxDiffFiles = 40

// diffSinceBase is `git diff --numstat <base>` over the working tree plus the untracked files, without the specs and
// the run state: {files, added, removed, list: [{file, added, removed}]} sorted by path. nil without a base or git.
func (e *Env) diffSinceBase() map[string]any {
	base := e.changeBase()
	if base == "" {
		return nil
	}
	ls := gitx.Lines(e.code, "diff", "--numstat", "--no-renames", base, "--")
	if ls == nil {
		return nil
	}
	tr := e.paths()
	keep := func(f string) bool { return !tr.IsSpecPath(f) && !strings.HasPrefix(f, layout.Dir+"/") }
	type stat struct {
		file           string
		added, removed int
	}
	var all []stat
	for _, l := range ls {
		parts := strings.SplitN(l, "\t", 3)
		if len(parts) != 3 || !keep(parts[2]) {
			continue
		}
		a, _ := strconv.Atoi(parts[0]) // "-" for a binary file: 0
		r, _ := strconv.Atoi(parts[1])
		all = append(all, stat{parts[2], a, r})
	}
	others := runstate.Files(e.code).Untracked
	if !runstate.Files(e.code).OK {
		others = gitx.Lines(e.code, "ls-files", "--others", "--exclude-standard")
	}
	for _, f := range others {
		if !keep(f) {
			continue
		}
		n := 0
		if b, err := os.ReadFile(filepath.Join(e.code, filepath.FromSlash(f))); err == nil && !bytes.Contains(b, []byte{0}) {
			n = bytes.Count(b, []byte("\n"))
			if len(b) > 0 && b[len(b)-1] != '\n' {
				n++
			}
		}
		all = append(all, stat{f, n, 0})
	}
	slices.SortFunc(all, func(a, b stat) int { return strings.Compare(a.file, b.file) })
	added, removed := 0, 0
	list := []map[string]any{}
	for i, s := range all {
		added += s.added
		removed += s.removed
		if i < maxDiffFiles {
			list = append(list, map[string]any{"file": s.file, "added": s.added, "removed": s.removed})
		}
	}
	return map[string]any{"files": len(all), "added": added, "removed": removed, "list": list}
}
