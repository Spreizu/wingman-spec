package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

func (e *Env) SyncReport() (*Obj, bool, error) {
	changeDir, err := e.changeDir()
	if err != nil {
		return nil, false, err
	}
	base, err := change.SyncCheck(e.R, e.O.Change)
	if err != nil {
		return nil, false, die(Usage, "%v", err)
	}
	r := e.tr().SyncCheck(changeDir, base)
	next := fmt.Sprintf("synced: archive with `wingman-spec archive %s`", e.O.Change)
	if !r.OK {
		next = fmt.Sprintf("not synced yet: `wingman-spec archive %s` gates, merges and archives in one step; fix the problems it reports. Never edit the living specs by hand.", e.O.Change)
	}
	var diffs []any
	if m, err := change.Merged(e.R, changeDir, false); err == nil && m != nil {
		for name, neu := range m.Specs {
			oldb, _ := os.ReadFile(filepath.Join(e.R.LivingSpecs(), name+".md"))
			if d := spec.Unified(name+".md", string(oldb), neu); d != "" {
				diffs = append(diffs, d)
			}
		}
	}
	return O("synced", r.OK, "mode", trace.Mode(e.Cfg), "parts", r.Parts, "problems", list(r.Problems), "warnings", list(r.Warnings), "diffs", NonEmpty(diffs), "next", next), r.OK, nil
}

// createdAt is when the change folder was first committed ("" when unknown).
func (e *Env) createdAt(changeDir string) string {
	ls := gitx.Lines(filepath.Dir(changeDir), "log", "--diff-filter=A", "--format=%aI", "--", filepath.Base(changeDir))
	if len(ls) == 0 {
		return ""
	}
	t, err := time.Parse(time.RFC3339, ls[len(ls)-1])
	if err != nil {
		return ""
	}
	return timeline.IsoLocal(t)
}

// gateCheck is one condition of the archive gate.
type gateCheck struct {
	Check   string   `json:"check"`
	OK      bool     `json:"ok"`
	Problem string   `json:"problem,omitempty"`
	Details []string `json:"details,omitempty"`
	Skipped string   `json:"skipped,omitempty"`
	blocked bool
}

// archiveGate checks everything archive needs before it writes anything: no BLOCKED.md, every task done, no open
// dispatch or pending review, finish passed on the code as it is now, lint clean (it includes validate) and the delta
// specs merge cleanly. Every condition is checked and reported.
func (e *Env) archiveGate(changeDir string) []gateCheck {
	var out []gateCheck
	add := func(g gateCheck) { g.OK = g.Problem == ""; out = append(out, g) }
	g := gateCheck{Check: "blocked"}
	if exists(filepath.Join(changeDir, "BLOCKED.md")) {
		g.Problem, g.blocked = "BLOCKED.md exists: run /spec-fix first", true
	}
	add(g)
	g = gateCheck{Check: "tasks"}
	if exists(tasksFile(changeDir)) {
		if ts, _, err := loadTasks(changeDir); err != nil {
			g.Problem = err.Error()
		} else {
			for _, t := range ts {
				if !t.Done {
					g.Details = append(g.Details, t.Desc)
				}
			}
			if len(g.Details) > 0 {
				g.Problem = fmt.Sprintf("%d task(s) are not done: finish /spec-apply (or /spec-fix) first", len(g.Details))
			}
		}
	}
	add(g)
	g = gateCheck{Check: "findings"}
	if run := e.currentRun(false); run != "" {
		if st, err := readState(run); err == nil {
			switch {
			case st.Review != nil:
				g.Problem = "a visual review is pending: record the reviewer's reply with `wingman-spec review " + e.O.Change + " --reply <file>`"
			case st.Task != nil:
				g.Problem = fmt.Sprintf("task %s was handed out and not checked: run `wingman-spec check %s`", st.Task.Label, e.O.Change)
			}
		}
	}
	if base := e.changeBase(); base != "" && g.Problem == "" {
		if rep, lvl := e.guardReport(changeDir, base, "change", nil); rep != nil && lvl == "error" && len(rep.Findings) > 0 {
			for _, x := range rep.Findings {
				g.Details = append(g.Details, fmt.Sprintf("%s:%d: %s", x.File, max(1, x.Line), x.Text))
			}
			g.Problem = fmt.Sprintf("%d anchor guard finding(s) are open: run `wingman-spec guard %s` and fix what it reports", len(rep.Findings), e.O.Change)
		}
	}
	add(g)
	g = gateCheck{Check: "finish"}
	var fin runstate.Record
	var now string
	if !trace.IsSpecOnly(changeDir) {
		now = runstate.GateTree(e.code)
	}
	switch {
	case trace.IsSpecOnly(changeDir):
		g.Skipped = "spec-only change: no code to check"
	case !runstate.ReadJSON(filepath.Join(e.runsDir(), "finished.json"), &fin):
		g.Problem = fmt.Sprintf("finish has not passed: run `wingman-spec finish %s`", e.O.Change)
	case now == "":
		g.Skipped = "not a git checkout: cannot tell whether the code changed since finish passed"
	case fin.Gate == "":
		g.Problem = fmt.Sprintf("finish passed before this version recorded what it checked: run `wingman-spec finish %s` again", e.O.Change)
	case fin.Gate != now:
		g.Problem = fmt.Sprintf("the code or the plan changed since finish passed (%s, at %s): run `wingman-spec finish %s` again", fin.At, shortHead(fin.Head), e.O.Change)
		g.Details = runstate.GateChanges(e.code, fin.Gate, now)
		if n := len(g.Details); n > 10 {
			g.Details = append(g.Details[:10], fmt.Sprintf("and %d more", n-10))
		}
	}
	add(g)
	g = gateCheck{Check: "lint"}
	// A settings error (a placeholder command) is finish's concern, not the plan's: a spec-only change has no code to run.
	if _, ok, located := e.lint(changeDir); !ok {
		settings := false
		for _, l := range located {
			switch {
			case strings.HasPrefix(l, "wingman-spec.yaml"):
				settings = true
			case strings.Contains(l, ": error: "):
				g.Details = append(g.Details, l)
			}
		}
		if len(g.Details) > 0 || !settings {
			g.Problem = fmt.Sprintf("`wingman-spec lint %s` fails: fix what it reports", e.O.Change)
		}
	}
	add(g)
	g = gateCheck{Check: "merge"}
	if res, err := change.Sync(e.R, e.O.Change, true); err != nil {
		g.Problem = err.Error()
	} else if len(res.Problems) > 0 {
		g.Problem, g.Details = "the delta specs do not merge cleanly into the living specs (nothing was written)", res.Problems
	}
	add(g)
	return out
}

func shortHead(h string) string {
	if len(h) > 7 {
		return h[:7]
	}
	if h == "" {
		return "no commit"
	}
	return h
}

// Archive is the archive gate, then the sync (specs merged, ADRs promoted), then the move to the archive with the
// change's timeline and archived.json. It refuses with every failed condition listed; there is no override.
func (e *Env) Archive() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	gate := e.archiveGate(changeDir)
	var failed []string
	blocked := false
	for _, g := range gate {
		if !g.OK {
			failed = append(failed, g.Check+": "+g.Problem)
			for _, d := range g.Details {
				failed = append(failed, g.Check+": "+d)
			}
			blocked = blocked || g.blocked
		}
	}
	refuse := func(why string, extra ...any) error {
		e.say("REFUSED: %s is not archived:\n  - %s", e.O.Change, strings.Join(failed, "\n  - "))
		ok := false
		e.tl(timeline.Event{Event: "archive", OK: &ok, Summary: why, Details: map[string]any{"failures": failed}})
		e.print(O(append([]any{"result", "refused", "problem", why, "problems", failed, "gate", gate}, extra...)...))
		if blocked {
			return quit(Blocked)
		}
		return quit(Fail)
	}
	if len(failed) > 0 {
		return refuse(fmt.Sprintf("%d archive condition(s) fail: fix each, then archive again", len(failed)), "next", "fix what each failed check says; nothing was written")
	}
	res, err := change.Sync(e.R, e.O.Change, false)
	if err != nil {
		return die(Usage, "%v", err)
	}
	if len(res.Problems) > 0 {
		for _, p := range res.Problems {
			failed = append(failed, "merge: "+p)
		}
		return refuse("the sync failed: nothing was written")
	}
	ok := true
	e.tl(timeline.Event{Event: "sync", OK: &ok, Summary: "specs merged and ADRs promoted (archive)", Details: map[string]any{"capabilities": res.Capabilities}})
	sr, ok, err := e.SyncReport()
	if err != nil {
		return err
	}
	if !ok {
		probs, _ := sr.Get("problems").([]string)
		for _, p := range probs {
			failed = append(failed, "sync: "+p)
		}
		return refuse("the specs are merged, but the sync check fails: fix it, then archive again (the merge is not repeated)", "sync", sr.Get("parts"))
	}
	created := e.createdAt(changeDir)
	now := time.Now()
	dst, err := change.Archive(e.R, e.O.Change, now)
	secs := float64(time.Since(e.t0).Milliseconds()/100) / 10
	okp := err == nil
	if err != nil {
		e.tl(timeline.Event{Event: "archive", OK: &okp, Seconds: &secs, Summary: "archive failed", Details: map[string]any{"error": err.Error()}})
		e.print(O("result", "failed", "error", err.Error(), "next", "see error"))
		return quit(Fail)
	}
	rec, _ := timeline.WriteArchived(dst, now, created)
	e.tl(timeline.Event{Event: "archive", OK: &okp, Seconds: &secs, Summary: "archived at " + rec.ArchivedAt})
	timeline.Keep(e.R.Runs(e.O.Change), dst)
	timeline.Anchor(dst)
	e.writeTraceArtifact(dst)
	e.print(O("result", "archived", "dir", dst, "archived_at", rec.ArchivedAt, "timeline_head", timeline.Verify(filepath.Join(dst, timeline.File)).Head, "gate", gate, "capabilities", res.Capabilities, "adrs", res.ADRs, "sync", sr.Get("parts"), "warnings", sr.Get("warnings"), "next", "the archive move is left uncommitted for you to review"))
	return nil
}

// timelineProblems lists the timelines (open and archived changes) whose hash chain is broken.
func timelineProblems(r *layout.Root) []string {
	var out []string
	rel := func(f string) string { x, _ := filepath.Rel(r.Specs, f); return filepath.ToSlash(x) }
	runs, _ := filepath.Glob(filepath.Join(r.Runs("*"), timeline.File))
	for _, f := range runs {
		if p := timeline.Verify(f).Problem(rel(f)); p != "" {
			out = append(out, p)
		}
	}
	arch, _ := change.Archived(r)
	for _, a := range arch {
		d := filepath.Join(r.Archive(), a)
		if p := timeline.VerifyArchived(d).Problem(rel(filepath.Join(d, timeline.File))); p != "" {
			out = append(out, p)
		}
	}
	return out
}
