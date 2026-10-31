package verify

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// Member is one task of a dispatch, as state.json records it.
type Member struct {
	Description string   `json:"description"`
	File        string   `json:"file"`
	Line        int      `json:"line"`
	Label       string   `json:"label"`
	Title       string   `json:"title"`
	Details     []string `json:"details"`
	DoneWhen    DoneWhen `json:"done_when"`
}

// DoneWhen is a task's `Done when:` line and its command (nil when absent).
type DoneWhen struct {
	Line *string `json:"line"`
	Cmd  *string `json:"cmd"`
}

// TaskState is the dispatch `next` handed out: the first task, and every member of a batch.
type TaskState struct {
	Member
	Members []Member `json:"members,omitempty"`
}

// ReviewState is a pending visual review.
type ReviewState struct {
	Prompt  string   `json:"prompt"`
	Dir     string   `json:"dir"`
	Checks  []any    `json:"checks"`
	Seconds float64  `json:"seconds"`
	Started string   `json:"started"`
	Rubric  []string `json:"rubric,omitempty"`
	Visual  any      `json:"visual,omitempty"`
}

// Snap is a file snapshot taken by `next` (restored on reject).
type Snap struct {
	File string `json:"file"`
	Snap string `json:"snap"`
}

// PreTask is a task as it was when the dispatch was handed out.
type PreTask struct {
	Description string `json:"description"`
	Done        bool   `json:"done"`
}

// State is state.json of a run.
type State struct {
	Change       string          `json:"change"`
	Started      string          `json:"started"`
	Task         *TaskState      `json:"task"`
	Attempts     int             `json:"attempts"`
	LastFailure  *string         `json:"last_failure"`
	AttemptOpen  bool            `json:"attempt_open"`
	Exhausted    bool            `json:"exhausted,omitempty"`
	Passed       bool            `json:"passed,omitempty"`
	PreTasks     []PreTask       `json:"pre_tasks"`
	Snapshots    []Snap          `json:"snapshots"`
	Review       *ReviewState    `json:"review,omitempty"`
	VisualBefore json.RawMessage `json:"visual_before,omitempty"`
	Base         string          `json:"base,omitempty"`
	Wave         *Wave           `json:"wave,omitempty"`
	Waves        int             `json:"waves,omitempty"` // waves handed out in this run

	parent *State // set on a lane view: writeState stores the view into its lane of parent.Wave
	lane   *Lane
}

func (s *State) members() []Member {
	if s.Task == nil {
		return nil
	}
	if len(s.Task.Members) > 0 {
		return s.Task.Members
	}
	return []Member{s.Task.Member}
}

func memberOf(t *tasks.Task, file string) Member {
	m := Member{Description: describe(t), File: file, Line: t.Line, Label: t.Label, Title: t.Title, Details: list(t.Detail)}
	if l, c := t.DoneWhen(); l != "" {
		m.DoneWhen.Line = new(l)
		if c != "" {
			m.DoneWhen.Cmd = new(c)
		}
	}
	return m
}

func stamp() string {
	return strings.NewReplacer("-", "", ":", "").Replace(time.Now().UTC().Format("2006-01-02T15:04:05Z"))
}

// currentRun is the open run directory ("" when none and !create).
func (e *Env) currentRun(create bool) string {
	d := e.runsDir()
	ptr := filepath.Join(d, "current")
	if id := strings.TrimSpace(readText(ptr)); id != "" && exists(filepath.Join(d, id)) {
		return filepath.Join(d, id)
	}
	if !create {
		return ""
	}
	id := fmt.Sprintf("%s-%d", stamp(), os.Getpid())
	for n := 1; exists(filepath.Join(d, id)); n++ {
		id = fmt.Sprintf("%s-%d-%d", stamp(), os.Getpid(), n)
	}
	_ = os.MkdirAll(filepath.Join(d, id, "pre"), 0o755)
	now := runstate.Now()
	me := runstate.Me(e.O.Session, e.code)
	fp := runstate.Fingerprinted(e.code, false)
	rec := runstate.Run{ID: id, Session: me.Session, PID: me.PID, Host: me.Host, Worktree: me.Worktree, Started: now, LastActivity: now, Head: fp.Head, Branch: fp.Branch}
	_ = runstate.WriteJSON(filepath.Join(d, id, "run.json"), rec)
	_ = os.WriteFile(ptr, []byte(id+"\n"), 0o644)
	e.status = "new " + runstate.Describe(&rec, time.Now(), true)
	e.say("%s", e.status)
	e.tl(timeline.Event{Event: "run-start", Run: id, Summary: fmt.Sprintf("run started (%s)", e.O.Cmd)})
	return filepath.Join(d, id)
}

func readState(run string) (*State, error) {
	var s State
	b, err := os.ReadFile(filepath.Join(run, "state.json"))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func writeState(run string, s *State) {
	if s.parent != nil {
		s = s.syncLane()
	}
	_ = runstate.WriteJSON(filepath.Join(run, "state.json"), s)
}

func logMetric(run string, rec *Obj) {
	x := O("at", runstate.Now()).Merge(rec)
	b, err := marshal(x)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(run, "metrics.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = f.Write(append(b, '\n'))
}

func closeRun(e *Env, run, reason string) {
	logMetric(run, O("event", "run-end", "reason", reason))
	_ = os.Remove(filepath.Join(e.runsDir(), "current"))
}

// ---------- ledger: tasks whose tick a check passed ----------

func (e *Env) ledgerFile() string { return filepath.Join(e.runsDir(), "verified.json") }

func (e *Env) readLedger(ts []taskRef) *runstate.Ledger {
	var l runstate.Ledger
	if runstate.ReadJSON(e.ledgerFile(), &l) {
		if l.Passed == nil {
			l.Passed = map[string]*runstate.Record{}
		}
		if l.Baseline == nil {
			l.Baseline = []string{}
		}
		return &l
	}
	l = runstate.Ledger{Baseline: []string{}, Passed: map[string]*runstate.Record{}}
	for _, t := range ts {
		if t.Done {
			l.Baseline = append(l.Baseline, t.Desc)
		}
	}
	_ = runstate.WriteJSON(e.ledgerFile(), l)
	return &l
}

func (e *Env) recordPass(run string, m Member) {
	l := e.readLedger(nil)
	var rec runstate.Run
	runstate.ReadJSON(filepath.Join(run, "run.json"), &rec)
	fp := runstate.Fingerprinted(e.code, true)
	l.Passed[m.Description] = &runstate.Record{At: runstate.Now(), Run: filepath.Base(run), Session: rec.Session, Head: fp.Head, Branch: fp.Branch, Tree: fp.Tree, Worktree: e.code, FilesHash: runstate.FilesHash(e.code, filesOf(m.Details))}
	_ = runstate.WriteJSON(e.ledgerFile(), l)
}

// foreignRecords are ticked tasks whose passing check was recorded on another branch or checkout.
func (e *Env) foreignRecords(ts []taskRef, l *runstate.Ledger) map[string]string {
	out := map[string]string{}
	any := false
	for _, t := range ts {
		if t.Done && l.Passed[t.Desc] != nil {
			any = true
		}
	}
	if !any {
		return out
	}
	fp := runstate.Fingerprinted(e.code, true)
	for _, t := range ts {
		rec := l.Passed[t.Desc]
		if !t.Done || rec == nil {
			continue
		}
		if st, note := runstate.Judge(e.code, rec, fp, runstate.FilesHash(e.code, filesOf(t.T.Detail))); st == "foreign" {
			out[t.Desc] = note
		}
	}
	return out
}

// ---------- the change lock and run ownership ----------

// guardRun takes the change lock and refuses another session's live run (unless --takeover); it records the activity.
func (e *Env) guardRun() error {
	dir := e.runsDir()
	me := runstate.Me(e.O.Session, e.code)
	refuse := func(result, text string, extra *Obj) error {
		e.print(O("result", result).Merge(extra).Set("fix", text))
		e.say("REFUSED: %s", text)
		return quit(Usage)
	}
	lk, h, err := runstate.Acquire(dir, me, e.O.Cmd, e.O.Takeover)
	if err != nil {
		return die(Usage, "cannot take the lock of '%s': %v", e.O.Change, err)
	}
	if lk == nil {
		sess := ""
		if h.Session != "" {
			sess = ", session " + h.Session
		}
		return refuse("busy", fmt.Sprintf("another wingman-spec command is running on '%s': `%s` (pid %d%s, started %s, last heartbeat %d min ago). Wait for it to end. Two commands on one change would overwrite each other's task snapshots. If its process is gone, rerun with --takeover.", e.O.Change, h.Command, h.PID, sess, h.Started, runstate.Minutes(h.Heartbeat, time.Now())), O("holder", h))
	}
	e.lock = lk
	run := e.currentRun(false)
	if run == "" {
		return nil
	}
	var rec runstate.Run
	if !runstate.ReadJSON(filepath.Join(run, "run.json"), &rec) {
		return nil
	}
	ow := runstate.Owner(&rec, me, time.Now())
	if ow.Foreign && !e.O.Takeover && ow.Idle < runstate.IdleMin {
		who, notMe := "the worktree "+rec.Worktree, "this worktree "+me.Worktree
		if ow.OtherSession {
			who, notMe = "session "+rec.Session, "your session "+me.Session
		}
		return refuse("run-owned", fmt.Sprintf("the open run of '%s' belongs to %s, not to %s: %s. Another agent may be working on this change right now; stop, do not start a second run. If that run is dead, rerun with --takeover (it is also adopted automatically after %d idle minutes).", e.O.Change, who, notMe, runstate.Describe(&rec, time.Now(), false), runstate.IdleMin),
			O("run", filepath.Base(run), "owner", O("session", rec.Session, "worktree", rec.Worktree, "branch", rec.Branch, "head", rec.Head, "started", rec.Started, "idle_minutes", ow.Idle)))
	}
	now := runstate.Now()
	if ow.Foreign {
		why := fmt.Sprintf("idle %d min", ow.Idle)
		if e.O.Takeover {
			why = "--takeover"
		}
		logMetric(run, O("event", "takeover", "from", O("session", rec.Session, "worktree", rec.Worktree, "pid", rec.PID), "to", O("session", me.Session, "worktree", me.Worktree), "idle_minutes", ow.Idle, "why", why))
		e.status = fmt.Sprintf("took over %s (%s)", runstate.Describe(&rec, time.Now(), false), why)
		rec.Session, rec.Worktree, rec.PID, rec.TakenOverAt = me.Session, me.Worktree, me.PID, now
		e.tl(timeline.Event{Event: "takeover", Run: filepath.Base(run), Summary: e.status})
	} else {
		lead := "own"
		if ow.Unknown {
			lead = "resuming (the session of this run is unknown: pass --session or set WINGMAN_SPEC_SESSION so that a second agent is refused)"
		}
		e.status = lead + " " + runstate.Describe(&rec, time.Now(), false)
	}
	rec.LastActivity = now
	_ = runstate.WriteJSON(filepath.Join(run, "run.json"), rec)
	e.say("%s", e.status)
	return nil
}

// Close releases the change lock.
func (e *Env) Close() {
	if e.lock != nil {
		e.lock.Release()
	}
}

// ---------- the timeline ----------

func firstLine(s string) string { l, _, _ := strings.Cut(s, "\n"); return l }

func (e *Env) seconds(x *Obj) *float64 {
	s := time.Since(e.t0).Seconds()
	if v, ok := x.Get("seconds").(float64); ok {
		s = v
	}
	s = float64(int(s*10+0.5)) / 10
	return &s
}

func strs(v any) []string {
	switch xs := v.(type) {
	case []string:
		return xs
	case []any:
		var out []string
		for _, x := range xs {
			out = append(out, fmt.Sprint(x))
		}
		return out
	}
	return nil
}

// timelineOf writes the timeline event of a verdict.
func (e *Env) timelineOf(x *Obj) {
	cmd := e.O.Cmd
	sec := e.seconds(x)
	task, _ := x.Get("task").(string)
	if ts, ok := x.Get("task").(*PacketTask); ok {
		task = ts.Label
	}
	result, _ := x.Get("result").(string)
	why := func() string {
		if f := strs(x.Get("failures")); len(f) > 0 {
			return ": " + firstLine(f[0])
		}
		if p, ok := x.Get("problem").(string); ok && p != "" {
			return ": " + p
		}
		return ""
	}
	fails := map[string]any{}
	if x.Has("failures") {
		fails["failures"] = x.Get("failures")
	}
	if x.Has("output_tail") {
		fails["output_tail"] = x.Get("output_tail")
	}
	switch cmd {
	case "next":
		if result == "task" {
			ts, _ := x.Get("task").(*PacketTask)
			sum := "picked"
			if b, ok := x.Get("batch").([]PacketTask); ok && len(b) > 1 {
				var ls []string
				for _, m := range b {
					ls = append(ls, m.Label)
				}
				sum += " " + strings.Join(ls, ", ")
			} else if ts != nil {
				sum += " " + task + " " + ts.Title
			}
			var files []string
			if ts != nil {
				files = fileRE.FindAllString(strings.Join(ts.Details, "\n"), -1)
			}
			e.tl(timeline.Event{Event: "next", OK: new(true), Task: task, Seconds: sec, Summary: sum, Details: map[string]any{"files": files}})
			return
		}
		sum := result + why()
		if result == "complete" {
			sum = "every task is ticked: finish is next"
		}
		e.tl(timeline.Event{Event: "next", OK: new(result == "complete"), Seconds: sec, Summary: sum, Details: map[string]any{"failures": x.Get("problems")}})
	case "check", "review":
		if v, ok := x.Get("visual").(*Obj); ok {
			sum := ""
			skipped, _ := v.Get("skipped").(string)
			defects := toInt(v.Get("defects"))
			if skipped != "" {
				sum = "visual check skipped: " + skipped
			} else {
				sum = fmt.Sprintf("%d visual scenario(s), %d defect(s), %d area image(s)", len(strs(v.Get("scenarios"))), defects, toInt(v.Get("area_images")))
			}
			var files []string
			for _, k := range []string{"report", "dir"} {
				if s, ok := v.Get(k).(string); ok {
					files = append(files, s)
				}
			}
			var vs *float64
			if f, ok := v.Get("seconds").(float64); ok {
				vs = &f
			}
			e.tl(timeline.Event{Event: "visual", Task: task, OK: new(defects == 0 && skipped == ""), Seconds: vs, Summary: sum, Details: map[string]any{"files": files}})
		}
		if result == "review-pending" {
			var files []string
			for _, k := range []string{"review_prompt", "dir"} {
				if s, ok := x.Get(k).(string); ok {
					files = append(files, s)
				}
			}
			e.tl(timeline.Event{Event: "review-packet", Task: task, Seconds: sec, Summary: "visual review packet ready for an independent reviewer", Details: map[string]any{"files": files}})
			return
		}
		ok := result == "passed"
		sum := result + why()
		if ok {
			sum = "all checks passed"
			if cmd == "review" {
				sum = "visual review passed"
			}
		}
		e.tl(timeline.Event{Event: cmd, Task: task, OK: new(ok), Seconds: sec, Summary: sum, Details: fails})
		if ok {
			e.tl(timeline.Event{Event: "tick", Task: task, OK: new(true), Summary: "ticked " + task})
		} else if result == "failed" {
			e.tl(timeline.Event{Event: "fix-round", Task: task, Summary: fmt.Sprintf("fix round %d of %d", toInt(x.Get("attempt"))+1, toInt(x.Get("max_attempts")))})
		}
	case "finish":
		sum := result + why()
		if result == "finished" {
			sum = "change verified"
		}
		e.tl(timeline.Event{Event: "finish", OK: new(result == "finished"), Seconds: sec, Summary: sum, Details: fails})
	case "sync", "sync-check":
		synced, _ := x.Get("synced").(bool)
		sum := "specs and code in sync"
		if !synced {
			sum = fmt.Sprintf("not synced: %d problem(s)", len(strs(x.Get("problems"))))
		}
		e.tl(timeline.Event{Event: "sync", OK: new(synced), Seconds: sec, Summary: sum, Details: map[string]any{"failures": x.Get("problems")}})
	}
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}
