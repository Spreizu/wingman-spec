package verify

import (
	"crypto/sha1" //nolint:gosec // a content fingerprint, not security
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// Lane states.
const (
	laneOpen      = "open"
	lanePassed    = "passed"
	laneBlocked   = "blocked"
	laneExhausted = "exhausted"
)

// Lane is one task of a parallel wave: its own attempts, failure text and visual state.
type Lane struct {
	Task         TaskState       `json:"task"`
	Status       string          `json:"status"`
	Attempts     int             `json:"attempts"`
	LastFailure  *string         `json:"last_failure"`
	AttemptOpen  bool            `json:"attempt_open"`
	Review       *ReviewState    `json:"review,omitempty"`
	VisualBefore json.RawMessage `json:"visual_before,omitempty"`
}

// Wave is a set of tasks of one group with disjoint Files:, handed out together for parallel implementers.
type Wave struct {
	N      int               `json:"n"`
	Lanes  []*Lane           `json:"lanes"`
	Hashes map[string]string `json:"hashes"` // content hash at `next` of every file changed then or named by a lane
}

func (w *Wave) lane(label string) (int, *Lane) {
	for i, l := range w.Lanes {
		if l.Task.Label == label {
			return i, l
		}
	}
	return -1, nil
}

func (w *Wave) labels(status ...string) []string {
	var out []string
	for _, l := range w.Lanes {
		if len(status) == 0 || slices.Contains(status, l.Status) {
			out = append(out, l.Task.Label)
		}
	}
	return out
}

// laneView is the State one lane's check or review works on; writeState stores it back into the lane.
func (s *State) laneView(l *Lane) *State {
	t := l.Task
	return &State{Change: s.Change, Started: s.Started, Task: &t, Attempts: l.Attempts, LastFailure: l.LastFailure, AttemptOpen: l.AttemptOpen,
		Exhausted: l.Status == laneExhausted, PreTasks: s.PreTasks, Snapshots: s.Snapshots, Review: l.Review, VisualBefore: l.VisualBefore,
		Base: s.Base, parent: s, lane: l}
}

// syncLane copies a lane view back into its lane and returns the wave's State to write.
func (s *State) syncLane() *State {
	p, l := s.parent, s.lane
	l.Attempts, l.LastFailure, l.AttemptOpen, l.Review, l.VisualBefore = s.Attempts, s.LastFailure, s.AttemptOpen, s.Review, s.VisualBefore
	switch {
	case s.Task == nil && l.Status != lanePassed:
		l.Status = lanePassed
		// The tick is the new baseline of tasks.md for the other lanes' checks.
		for _, sn := range p.Snapshots {
			if b, err := os.ReadFile(sn.File); err == nil {
				_ = os.WriteFile(sn.Snap, b, 0o644)
			}
		}
		for i := range p.PreTasks {
			if p.PreTasks[i].Description == l.Task.Description {
				p.PreTasks[i].Done = true
			}
		}
	case s.Exhausted:
		l.Status = laneExhausted
	}
	if p.Wave != nil && len(p.Wave.labels(laneOpen, laneBlocked, laneExhausted)) == 0 {
		p.Wave = nil // every lane passed: the wave is over
	}
	return p
}

// otherOpenLanes are the lanes of the wave, other than this view's, that have not passed.
func (s *State) otherOpenLanes() []string {
	if s.parent == nil || s.parent.Wave == nil {
		return nil
	}
	var out []string
	for _, l := range s.parent.Wave.Lanes {
		if l != s.lane && l.Status != lanePassed {
			out = append(out, l.Task.Label)
		}
	}
	return out
}

// ---------- forming a wave ----------

var manifestRE = regexp.MustCompile(`(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|go\.mod|go\.sum|go\.work|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|tsconfig[^/]*\.json)$|(^|/)migrations?/`)

// isManifest: a shared manifest, lockfile or migration (a task touching one runs alone).
func isManifest(f string) bool { return manifestRE.MatchString(f) }

// owns reports whether a `Files:` entry (a path, a directory ending in / or a glob) covers the file f.
func owns(entry, f string) bool {
	entry, f = strings.TrimPrefix(filepath.ToSlash(entry), "./"), strings.TrimPrefix(filepath.ToSlash(f), "./")
	switch {
	case entry == f:
		return true
	case strings.HasSuffix(entry, "/"):
		return strings.HasPrefix(f, entry)
	case strings.Contains(entry, "**"):
		pre, post, _ := strings.Cut(entry, "**")
		if !strings.HasPrefix(f, pre) {
			return false
		}
		post = strings.TrimPrefix(post, "/")
		if post == "" {
			return true
		}
		ok, _ := path.Match(post, path.Base(f))
		return ok
	case strings.ContainsAny(entry, "*?["):
		ok, _ := path.Match(entry, f)
		return ok
	}
	return false
}

func ownsAny(entries []string, f string) bool {
	return slices.ContainsFunc(entries, func(e string) bool { return owns(e, f) })
}

// overlap names a file both entry lists cover (globs expanded against the tree), "" when they are disjoint.
func overlap(a, b, tree []string) string {
	for _, x := range a {
		for _, y := range b {
			if owns(x, y) {
				return y
			}
			if owns(y, x) {
				return x
			}
		}
	}
	for _, f := range tree {
		if ownsAny(a, f) && ownsAny(b, f) {
			return f
		}
	}
	return ""
}

// laneable: a task that may share a wave (not a review task, names its files, touches no shared manifest).
func laneable(t *tasks.Task) bool {
	files := filesOf(t.Detail)
	return !tasks.IsReview(t.Label, t.Title) && len(files) > 0 && !slices.ContainsFunc(files, isManifest)
}

// parallelN is how many lanes one wave may have (1: no waves; 3 when the settings do not say).
func (e *Env) parallelN() int {
	if e.O.Parallel > 0 {
		return e.O.Parallel
	}
	if e.Cfg != nil && e.Cfg.Parallel > 0 {
		return e.Cfg.Parallel
	}
	return 3
}

// waveTasks picks the tasks of the pending task's group that may run at once: up to N laneable tasks with disjoint
// Files: and no After: on a task still open. Fewer than two: no wave. Size S keeps its one whole-change dispatch.
func (e *Env) waveTasks(changeDir string, ts []taskRef, pending int) []taskRef {
	n := e.parallelN()
	first := ts[pending]
	if n < 2 || !laneable(first.T) || quality.ReadProposalSize(readText(filepath.Join(changeDir, "proposal.md"))).Size == "S" {
		return nil
	}
	open := map[string]bool{}
	for _, t := range ts {
		if !t.Done && t.T.Label != "" {
			open[t.T.Label] = true
		}
	}
	tree := gitx.Lines(e.code, "ls-files", "-co", "--exclude-standard")
	picked := []taskRef{first}
	var used [][]string
	used = append(used, filesOf(first.T.Detail))
	for k := pending + 1; k < len(ts) && len(picked) < n; k++ {
		t := ts[k]
		if t.Done {
			continue
		}
		if t.T.Group != first.T.Group || !laneable(t.T) {
			break // a task that must run alone ends the wave: what follows it may need it
		}
		if slices.ContainsFunc(t.T.After(), func(l string) bool { return open[l] }) {
			continue
		}
		mine := filesOf(t.T.Detail)
		if slices.ContainsFunc(used, func(u []string) bool { return overlap(u, mine, tree) != "" }) {
			continue
		}
		picked = append(picked, t)
		used = append(used, mine)
	}
	if len(picked) < 2 {
		return nil
	}
	return picked
}

// ---------- file ownership ----------

func fileHash(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		return "-"
	}
	h := sha1.Sum(b) //nolint:gosec // a content fingerprint
	return hex.EncodeToString(h[:])
}

// waveHashes records every file changed now or named by a lane, so a check can tell what changed during the wave.
func (e *Env) waveHashes(lanes []*Lane) map[string]string {
	out := map[string]string{}
	for _, f := range e.changedFiles() {
		out[f] = fileHash(filepath.Join(e.code, f))
	}
	for _, l := range lanes {
		for _, f := range filesOf(l.Task.Details) {
			if !strings.ContainsAny(f, "*?[") && !strings.HasSuffix(f, "/") {
				out[filepath.ToSlash(f)] = fileHash(filepath.Join(e.code, f))
			}
		}
	}
	return out
}

// waveTouched lists the files changed since the wave was handed out.
func (e *Env) waveTouched(w *Wave) []string {
	cands := uniq(append(slices.Collect(mapKeys(w.Hashes)), e.changedFiles()...))
	var out []string
	for _, f := range cands {
		was, known := w.Hashes[f]
		now := fileHash(filepath.Join(e.code, f))
		if (known && was != now) || (!known && slices.Contains(e.changedFiles(), f)) {
			out = append(out, f)
		}
	}
	slices.Sort(out)
	return out
}

func mapKeys(m map[string]string) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}

// ownership checks that every file changed during the wave belongs to exactly one lane's Files: (a test file named
// after a lane's files counts as that lane's). Failures name the file; unowned test files are warnings.
func (e *Env) ownership(st *State) (failures, warnings []string) {
	w := st.parent.Wave
	if w == nil {
		return nil, nil
	}
	tests := []string{}
	for _, f := range e.waveTouched(w) {
		var by []string
		for _, l := range w.Lanes {
			files := filesOf(l.Task.Details)
			if ownsAny(files, f) || (testpaths.IsTestPath(f) && len(testpaths.TestsFor(files, []string{f})) > 0) {
				by = append(by, l.Task.Label)
			}
		}
		switch {
		case len(by) == 1:
		case len(by) > 1:
			failures = append(failures, fmt.Sprintf("%s is named by tasks %s of this wave: in a parallel wave each file belongs to exactly one task", f, strings.Join(by, ", ")))
		case testpaths.IsTestPath(f):
			tests = append(tests, f)
		default:
			failures = append(failures, fmt.Sprintf("%s changed during the parallel wave but no task of the wave names it in Files: (task %s may edit only %s); revert it or move the edit into the task that owns it", f, st.Task.Label, strings.Join(filesOf(st.Task.Details), ", ")))
		}
	}
	if len(tests) > 0 {
		warnings = append(warnings, "test files no task of the wave names (fine when they test this task): "+strings.Join(tests, ", "))
	}
	return failures, warnings
}

// attribute names the lanes whose files a failure text mentions.
func attribute(w *Wave, text string) []*Lane {
	var out []*Lane
	for _, l := range w.Lanes {
		for _, f := range filesOf(l.Task.Details) {
			if !strings.ContainsAny(f, "*?[") && mentions(text, strings.TrimPrefix(f, "./")) {
				out = append(out, l)
				break
			}
		}
	}
	return out
}

// mentions reports whether text names the path f as a whole (src/a.js is not src/a.jsx or lib/src/a.js... unless
// it ends in /, a directory: then any path under it counts).
func mentions(text, f string) bool {
	if f == "" {
		return false
	}
	for i := 0; ; {
		k := strings.Index(text[i:], f)
		if k < 0 {
			return false
		}
		start, end := i+k, i+k+len(f)
		before := start == 0 || !pathByte(text[start-1])
		after := strings.HasSuffix(f, "/") || end == len(text) || !pathByte(text[end]) || text[end] == '.' && (end+1 == len(text) || !pathByte(text[end+1]))
		if before && after {
			return true
		}
		i = start + 1
	}
}

func pathByte(c byte) bool {
	return c == '/' || c == '.' || c == '_' || c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// reopen unticks lanes that passed earlier in the wave when the wave's last check found their files broken.
func (e *Env) reopen(st *State, lanes []*Lane, failure string) []string {
	p := st.parent
	var labels []string
	led := e.readLedger(nil)
	for _, l := range lanes {
		if l.Status != lanePassed || l == st.lane {
			continue
		}
		m := l.Task.Member
		if b, err := os.ReadFile(m.File); err == nil {
			ls := strings.Split(string(b), "\n")
			if i := m.Line - 1; i >= 0 && i < len(ls) {
				ls[i] = strings.Replace(ls[i], "[x]", "[ ]", 1)
				_ = os.WriteFile(m.File, []byte(strings.Join(ls, "\n")), 0o644)
			}
		}
		delete(led.Passed, m.Description)
		for i := range p.PreTasks {
			if p.PreTasks[i].Description == m.Description {
				p.PreTasks[i].Done = false
			}
		}
		l.Status, l.AttemptOpen = laneOpen, false
		l.Attempts++
		f := "the wave's last check failed on this task's files:\n" + failure
		l.LastFailure = &f
		if l.Attempts >= e.O.MaxAttempts {
			l.Status = laneExhausted
		}
		labels = append(labels, l.Task.Label)
	}
	if len(labels) > 0 {
		_ = runstate.WriteJSON(e.ledgerFile(), led)
		for _, sn := range p.Snapshots {
			if b, err := os.ReadFile(sn.File); err == nil {
				_ = os.WriteFile(sn.Snap, b, 0o644)
			}
		}
	}
	return labels
}

// pickLane selects the lane a check or review works on (--task, or the only lane that can be meant).
func (e *Env) pickLane(st *State, review bool) (*State, error) {
	w := st.Wave
	if w == nil {
		if e.O.Task != "" && st.Task != nil && !slices.ContainsFunc(st.members(), func(m Member) bool { return m.Label == e.O.Task }) {
			return nil, die(Usage, "task %s is not the task in progress (%s)", e.O.Task, st.Task.Label)
		}
		return st, nil
	}
	label := e.O.Task
	if label == "" {
		var cands []string
		for _, l := range w.Lanes {
			if (review && l.Review != nil) || (!review && l.Status != lanePassed) {
				cands = append(cands, l.Task.Label)
			}
		}
		if len(cands) != 1 {
			return nil, die(Usage, "a parallel wave is open (tasks %s): pass --task <label> to say which task's subagent returned", strings.Join(w.labels(), ", "))
		}
		label = cands[0]
	}
	i, l := w.lane(label)
	if l == nil {
		return nil, die(Usage, "task %s is not in the open wave (tasks %s)", label, strings.Join(w.labels(), ", "))
	}
	if l.Status == lanePassed {
		return nil, die(Usage, "task %s already passed in this wave; open tasks: %s", label, strings.Join(w.labels(laneOpen, laneBlocked), ", "))
	}
	if l.Status == laneBlocked {
		l.Status = laneOpen
	}
	e.wave, e.lane = w.N, i+1
	return st.laneView(l), nil
}

// waveObj is the wave summary a lane's result carries.
func waveObj(st *State) any {
	p := st
	if st.parent != nil {
		p = st.parent
	}
	if p.Wave == nil {
		if st.lane != nil {
			return O("open", []string{}, "done", true)
		}
		return Skip
	}
	return O("n", p.Wave.N, "open", list(p.Wave.labels(laneOpen, laneBlocked)), "passed", list(p.Wave.labels(lanePassed)), "exhausted", list(p.Wave.labels(laneExhausted)))
}
