package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/checkparse"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
)

// Retry bookkeeping of one task: a failure fingerprint per attempt, the pre-task tree, and the implementer's note.
// Two attempts in a row that fail the same way rule that approach out: the next attempt is the last one and starts
// over from the pre-task tree, or the task stops when no attempt is left.

const noteWords = 150

var (
	ansiRE     = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	durationRE = regexp.MustCompile(`\(?\b\d+(\.\d+)?\s?(ms|s|µs)\b\)?`)
	posRE      = regexp.MustCompile(`:\d+(:\d+)?\b`)
	hexRE      = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)
	tmpRE      = regexp.MustCompile(`/(tmp|var/folders|private/var)/\S*`)
	spaceRE    = regexp.MustCompile(`\s+`)
	errLineRE  = regexp.MustCompile(`(?i)(error|assert|expected|exception|panic|cannot|undefined|not found|fail)`)
)

// normLine makes a line comparable across attempts: no colours, timings, line:column positions, hashes or temp paths.
func normLine(s string) string {
	s = ansiRE.ReplaceAllString(s, "")
	s = durationRE.ReplaceAllString(s, "")
	s = posRE.ReplaceAllString(s, "")
	s = hexRE.ReplaceAllString(s, "#")
	s = tmpRE.ReplaceAllString(s, "/tmp/…")
	return strings.TrimSpace(spaceRE.ReplaceAllString(s, " "))
}

// fingerprint is the failing check, the first failing test and the first error line of a rejected attempt, normalized.
// "" when no check ran (a subagent's own failed/blocked/no-status report): such attempts are never compared.
func fingerprint(checks []any, failures []string) string {
	name := ""
	for _, c := range checks {
		if x, ok := c.(*Obj); ok {
			if ok, _ := x.Get("ok").(bool); !ok {
				name, _ = x.Get("check").(string)
				break
			}
		}
	}
	if name == "" || len(failures) == 0 {
		return ""
	}
	text := ansiRE.ReplaceAllString(strings.Join(failures, "\n"), "")
	test := normLine(checkparse.Parse(text, nil).FirstFailure())
	first := ""
	lines := strings.Split(text, "\n")
	for _, l := range lines[1:] {
		if n := normLine(l); n != "" && n != test && errLineRE.MatchString(n) {
			first = n
			break
		}
	}
	if first == "" {
		first = normLine(lines[0])
	}
	return name + " | " + test + " | " + first
}

// notePath is where the implementer of a task keeps its attempt note (gitignored run state).
func (e *Env) notePath(label string) string {
	return filepath.Join(e.runsDir(), "notes", strings.NewReplacer("/", "_", " ", "_", ",", "_").Replace(label)+".md")
}

// readNote is the task's attempt note, cut to noteWords words; "" when there is none.
func (e *Env) readNote(label string) string {
	w := strings.Fields(layout.Text(e.notePath(label)))
	if len(w) == 0 {
		return ""
	}
	if len(w) > noteWords {
		return strings.Join(w[:noteWords], " ") + " [cut at 150 words]"
	}
	return strings.Join(w, " ")
}

// dropNotes discards the attempt notes of passed tasks.
func (e *Env) dropNotes(labels ...string) {
	for _, l := range labels {
		_ = os.Remove(e.notePath(l))
		_ = os.RemoveAll(e.notePath(l) + ".d")
	}
}

// savePre keeps the task's Files: as `next` hands it out (a missing file is listed as absent), for a start-over.
// Only those files are copied: no snapshot of the whole tree, nothing written into .git.
func (e *Env) savePre(t *TaskState) {
	d := e.notePath(t.Label) + ".d"
	e.dropNotes(t.Label) // a fresh dispatch starts with no note
	var absent []string
	for _, f := range taskFiles(t) {
		p := filepath.Join(e.code, f)
		fi, err := os.Stat(p)
		switch {
		case err != nil:
			absent = append(absent, f)
		case fi.Mode().IsRegular():
			if b, err := os.ReadFile(p); err == nil {
				_ = os.MkdirAll(filepath.Dir(filepath.Join(d, "pre", f)), 0o755)
				_ = os.WriteFile(filepath.Join(d, "pre", f), b, fi.Mode().Perm())
			}
		}
	}
	_ = os.MkdirAll(d, 0o755)
	_ = os.WriteFile(filepath.Join(d, "absent"), []byte(strings.Join(absent, "\n")), 0o644)
}

func taskFiles(t *TaskState) []string {
	files := filesOf(t.Details)
	for _, m := range t.Members {
		files = append(files, filesOf(m.Details)...)
	}
	return uniq(files)
}

// startOver keeps the failed attempt's diff of the task's files next to the note, then puts those files back as
// savePre kept them (a file the task created is removed). It returns the diff file, "" if nothing changed.
func (e *Env) startOver(st *State) string {
	d := e.notePath(st.Task.Label) + ".d"
	if !layout.Exists(filepath.Join(d, "absent")) {
		return ""
	}
	absent := strings.Fields(layout.Text(filepath.Join(d, "absent")))
	var diff strings.Builder
	var restore []string
	for _, f := range taskFiles(st.Task) {
		p, pre := filepath.Join(e.code, f), filepath.Join(d, "pre", f)
		switch {
		case slices.Contains(absent, f):
			if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
				fmt.Fprintf(&diff, "--- new file %s\n%s\n", f, layout.Text(p))
				restore = append(restore, f)
			}
		case layout.Exists(pre):
			if out, _ := gitx.RunRaw(e.code, nil, nil, "diff", "--no-index", "--", pre, p); out != "" {
				diff.WriteString(out)
				restore = append(restore, f)
			}
		}
	}
	if len(restore) == 0 {
		return ""
	}
	out := filepath.Join(d, fmt.Sprintf("attempt-%d.diff", st.Attempts))
	_ = os.WriteFile(out, []byte(diff.String()), 0o644)
	for _, f := range restore {
		p, pre := filepath.Join(e.code, f), filepath.Join(d, "pre", f)
		if slices.Contains(absent, f) {
			_ = os.Remove(p)
		} else if b, err := os.ReadFile(pre); err == nil {
			_ = os.WriteFile(p, b, 0o644)
		}
	}
	return out
}
