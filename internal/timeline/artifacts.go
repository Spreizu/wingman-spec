package timeline

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const artSnap = "artifacts-snapshot.json"

type artFile struct {
	Hash   string   `json:"hash"`
	Scens  []string `json:"scens,omitempty"`
	Visual []string `json:"visual,omitempty"` // scenarios with a ```visual block
}

// artifactFiles fingerprints the change's artifacts: proposal, app map, design, tasks, delta specs and ADRs.
func artifactFiles(changeDir string) map[string]artFile {
	out := map[string]artFile{}
	var files []string
	for _, f := range []string{"proposal.md", "app-map.md", "design.md", "tasks.md"} {
		files = append(files, filepath.Join(changeDir, f))
	}
	for _, g := range []string{"specs/*.md", "specs/*/*.md", "adrs/*.md"} {
		m, _ := filepath.Glob(filepath.Join(changeDir, g))
		files = append(files, m...)
	}
	for _, f := range files {
		t, ok := read(f)
		if !ok {
			continue
		}
		rel, _ := filepath.Rel(changeDir, f)
		a := artFile{Hash: sha(t)}
		if strings.HasPrefix(filepath.ToSlash(rel), "specs/") {
			scen, fence := "", false
			for l := range strings.SplitSeq(t, "\n") {
				s := strings.TrimSpace(l)
				if strings.HasPrefix(s, "```") {
					if !fence && strings.HasPrefix(s, "```visual") && scen != "" && !slices.Contains(a.Visual, scen) {
						a.Visual = append(a.Visual, scen)
					}
					fence = !fence
					continue
				}
				if m := scenRE.FindStringSubmatch(l); m != nil && !fence {
					scen = m[1]
					a.Scens = append(a.Scens, scen)
				} else if strings.HasPrefix(s, "#") && !fence {
					scen = ""
				}
			}
		}
		out[filepath.ToSlash(rel)] = a
	}
	return out
}

func missing(a, b []string) []string {
	var out []string
	for _, x := range a {
		if !slices.Contains(b, x) {
			out = append(out, x)
		}
	}
	return out
}

// Artifacts appends one artifact event per artifact written, rewritten or deleted since the last call (the first call
// records every artifact there is). Spec rewrites list the scenarios and visual blocks added or removed. source names
// what ran the command (cmd); both go into the details.
func Artifacts(dir, changeDir, cmd, source string) {
	now := artifactFiles(changeDir)
	f := filepath.Join(dir, artSnap)
	before := map[string]artFile{}
	if b, err := os.ReadFile(f); err == nil {
		_ = json.Unmarshal(b, &before)
	}
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	b, _ := json.Marshal(now)
	tmp := fmt.Sprintf("%s.%d", f, os.Getpid())
	if os.WriteFile(tmp, append(b, '\n'), 0o644) != nil || os.Rename(tmp, f) != nil {
		return
	}
	for _, k := range keys(before, now) {
		x, okx := before[k]
		y, oky := now[k]
		var sum string
		var changes []string
		switch {
		case !okx:
			sum = "wrote " + k
		case !oky:
			sum = "deleted " + k
		case x.Hash != y.Hash:
			sum = "rewrote " + k
		default:
			continue
		}
		for _, s := range missing(y.Scens, x.Scens) {
			changes = append(changes, "scenario added: "+s)
		}
		for _, s := range missing(x.Scens, y.Scens) {
			changes = append(changes, "scenario removed: "+s)
		}
		for _, s := range missing(y.Visual, x.Visual) {
			changes = append(changes, "visual block added: "+s)
		}
		for _, s := range missing(x.Visual, y.Visual) {
			changes = append(changes, "visual block removed: "+s)
		}
		if okx && oky && len(changes) > 0 {
			sum += fmt.Sprintf(" (%d scenario or visual change(s))", len(changes))
		}
		d := map[string]any{"changes": changes, "seen_at": cmd}
		if source != "" {
			d["source"] = source
		}
		Append(dir, Event{Event: "artifact", Summary: sum, Details: d})
	}
}
