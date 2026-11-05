package verify

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

func (e *Env) runChecks(changeDir, run string, st *State, tinfo CmdInfo, o *outcome) (vis *Obj, review string, rubric []string) {
	var cmds []step
	proj := map[string]string{}
	if tinfo.Cmd != nil {
		proj[norm(tinfo.cmd())] = "tests"
	}
	extras := e.extraCmds()
	for _, x := range extras {
		if x.Cmd != nil {
			if _, ok := proj[norm(x.cmd())]; !ok {
				proj[norm(x.cmd())] = x.Name
			}
		}
	}
	ran := map[string]bool{}
	for _, m := range st.members() {
		if m.DoneWhen.Cmd != nil {
			cmds = append(cmds, step{"done_when", *m.DoneWhen.Cmd, proj[norm(*m.DoneWhen.Cmd)]})
			for _, p := range doneWhenParts(*m.DoneWhen.Cmd) {
				ran[p] = true
			}
		} else {
			why := "no Done when line"
			if m.DoneWhen.Line != nil {
				why = "no `command` in Done when line"
			}
			o.check(O("check", "done_when", "ok", true, "skipped", why))
		}
	}
	deferWhy := e.deferReason(st)
	isReview := tasks.IsReview(st.Task.Label, st.Task.Title)
	switch {
	case tinfo.Cmd != nil && ran[norm(tinfo.cmd())]:
		o.check(O("check", "tests", "ok", true, "skipped", "already run by Done when"))
	case tinfo.Cmd != nil && e.testRun() == "finish":
		o.check(O("check", "tests", "ok", true, "skipped", "commands.test_run: finish (the project tests run once at finish)"))
	case tinfo.Cmd != nil && e.checkLevel() == "targeted" && !isReview:
		scens := e.scenariosOf(changeDir)
		tg := e.targetedTests(changeDir, st, tinfo.cmd(), scens)
		x := O("check", "targeted_tests", "ok", true, "files", len(tg.files))
		if tg.counts != nil {
			x.Set("from", tg.counts)
		}
		if tg.tpl != "" {
			x.Set("template", tg.tpl)
		}
		if tg.cmd == "" {
			x.Set("skipped", tg.why)
			e.say("note: tests not run at this check: %s", tg.why)
		} else {
			cmds = append(cmds, step{"tests", tg.cmd, ""})
		}
		o.check(x)
	case tinfo.Cmd != nil && deferWhy != "":
		o.check(O("check", "tests", "ok", true, "skipped", deferWhy))
	case tinfo.Cmd != nil:
		cmds = append(cmds, step{"tests", tinfo.cmd(), ""})
	default:
		o.check(O("check", "tests", "ok", true, "skipped", "commands.test: none"))
		o.warn("project tests were not run (commands.test: none)")
	}
	for _, x := range extras {
		switch {
		case x.Cmd == nil:
			if x.State == "placeholder" {
				o.warn(fmt.Sprintf("commands.%s is still %s in wingman-spec.yaml: %s was not run (set it, or write none)", x.Name, "<fill in>", x.Name))
			}
		case ran[norm(x.cmd())]:
			o.check(O("check", x.Name, "ok", true, "skipped", "already run by Done when"))
		case deferWhy != "":
			o.check(O("check", x.Name, "ok", true, "skipped", deferWhy))
		default:
			cmds = append(cmds, step{x.Name, x.cmd(), ""})
		}
	}
	cmds = append(cmds, step{name: "visual"}, step{name: "validate"})
	q := e.qualityChecks(changeDir, st, e.scenariosOf(changeDir))
	o.merge(q)
	if len(q.failures) > 0 {
		return nil, "", nil
	}
	tree := ""
	if slices.ContainsFunc(cmds, func(s step) bool { return projectCmds[s.name] || projectCmds[s.via] }) {
		tree = e.phaseTree()
	}
	ranCmds := map[string]string{}
	for _, c := range cmds {
		switch c.name {
		case "visual":
			var stop bool
			vis, review, rubric, stop = e.checkVisual(changeDir, run, st, o)
			if stop {
				return vis, "", nil
			}
			continue
		case "validate":
			if !e.validateCheck(o) {
				return vis, "", nil
			}
			continue
		}
		if prev, ok := ranCmds[norm(c.cmd)]; ok {
			o.check(O("check", c.name, "ok", true, "skipped", "same command as "+prev))
			continue
		}
		name := c.name
		if c.via != "" {
			name = c.via
		}
		r := e.runNamed(name, c.cmd, tree)
		if !r.Cached {
			e.dropIndex()
		}
		ranCmds[norm(c.cmd)] = c.name
		x := O("check", c.name, "ok", r.RC == 0, "rc", r.RC, "timed_out", r.TimedOut, "seconds", r.Seconds)
		if r.Cached {
			x.Set("cached", true)
		}
		o.check(x)
		if r.RC != 0 {
			text := e.failReport(c.name, r, tailMax)
			if st.lane != nil && c.name != "done_when" && !e.blameWave(st, text, o) {
				continue // the failure names only files of tasks that passed earlier in the wave: they are reopened
			}
			o.fail(text)
			return vis, "", nil
		}
	}
	e.reviewProof(changeDir, st, tinfo, o)
	return vis, review, rubric
}

// blameWave attributes a project command failure at a wave's last check: tasks of the wave whose files the output
// names are reopened (an earlier pass is unticked). It reports whether this check's task fails too: named, or nobody
// is named (then every task of the wave is reopened, to be re-dispatched one at a time).
func (e *Env) blameWave(st *State, text string, o *outcome) bool {
	w := st.parent.Wave
	if w == nil {
		return true
	}
	named := attribute(w, text)
	if len(named) == 0 {
		if re := e.reopen(st, w.Lanes, text); len(re) > 0 {
			o.warn(fmt.Sprintf("the failure names no file of one task, so the whole wave is reopened (tasks %s): re-dispatch them one at a time", strings.Join(re, ", ")))
		}
		return true
	}
	if re := e.reopen(st, named, text); len(re) > 0 {
		o.warn(fmt.Sprintf("the failure names files of tasks %s, which passed earlier in this wave: they are reopened and `next` hands them out again with this failure", strings.Join(re, ", ")))
	}
	return slices.Contains(named, st.lane)
}

// validateCheck validates the change in-process (the v1 `openspec validate --strict`).
func (e *Env) validateCheck(o *outcome) bool {
	t0 := time.Now()
	rep, err := validateChange(e.R, e.O.Change)
	secs := time.Since(t0).Seconds()
	if err != nil {
		o.check(O("check", "validate", "ok", false, "seconds", secs))
		o.fail("validate failed: " + err.Error())
		return false
	}
	if len(rep) > 0 {
		o.check(O("check", "validate", "ok", false, "rc", 1, "seconds", secs))
		o.fail(fmt.Sprintf("validate failed (exit 1): wingman-spec validate %s\n%s", e.O.Change, strings.Join(rep, "\n")))
		return false
	}
	o.check(O("check", "validate", "ok", true, "rc", 0, "seconds", secs))
	return true
}

// checkVisual runs the dispatch's visual check; stop is true on a failure.
func (e *Env) checkVisual(changeDir, run string, st *State, o *outcome) (vis *Obj, review string, rubric []string, stop bool) {
	p := e.visualPlan(changeDir, st)
	if !p.triggered {
		return nil, "", nil, false
	}
	if vp := visual.ConfigProblem(p.cfg); vp != "" {
		o.check(O("check", "visual", "ok", false, "reason", "config"))
		what := "task names " + strings.Join(ids(p.mine), ", ")
		if len(p.mine) == 0 {
			what = "UI files changed: " + strings.Join(p.touched[:min(5, len(p.touched))], ", ")
		}
		o.fail(fmt.Sprintf("visual check needed (%s) but %s", what, vp))
		return nil, "", nil, true
	}
	if p.cfg.Off {
		o.check(O("check", "visual", "ok", true, "skipped", "visual: off"))
		o.warn("UI work but `visual: off` in wingman-spec.yaml: nothing visual was checked")
		return nil, "", nil, false
	}
	if len(p.items) == 0 {
		o.check(O("check", "visual", "ok", true, "skipped", "no visual scenario covers the changed UI files"))
		o.warn(fmt.Sprintf("UI files changed (%s) but no visual scenario covers them: add one to the specs with /spec-fix so the next change is checked", strings.Join(p.touched[:min(5, len(p.touched))], ", ")))
		return nil, "", nil, false
	}
	outDir := filepath.Join(run, "visual", fmt.Sprintf("%s-a%d", st.Task.Label, st.Attempts+1))
	rep := e.runVisual(changeDir, p, st, run, outDir)
	writeState(run, st)
	var scen []string
	for _, it := range p.items {
		scen = append(scen, fmt.Sprintf("%s (%s)", it.Scenario.ID, it.Role))
	}
	vis = O("dir", outDir, "report", filepath.Join(outDir, "report.json"), "scenarios", scen, "before", rep.Before, "area_images", len(rep.Shots), "aria_changes", len(rep.ARIAChanges),
		"defects", len(rep.Defects), "preexisting_elsewhere", rep.Preexisting, "seconds", rep.Seconds, "before_seconds", rep.BeforeSeconds, "skipped", If(rep.skipped() != "", rep.skipped()), "warnings", list(rep.Warnings))
	o.warn(rep.Warnings...)
	if rep.skipped() != "" {
		o.check(O("check", "visual", "ok", !p.cfg.RequirePlaywright, "skipped", rep.skipped(), "seconds", rep.Seconds))
		if p.cfg.RequirePlaywright {
			first := ""
			if len(rep.Warnings) > 0 {
				first = rep.Warnings[0]
			}
			o.fail(fmt.Sprintf("visual check could not run (%s) and visual.require_playwright is true: %s", rep.skipped(), first))
			return vis, "", nil, true
		}
		return vis, "", nil, false
	}
	o.check(O("check", "visual", "ok", len(rep.Defects) == 0, "defects", len(rep.Defects), "area_images", len(rep.Shots), "seconds", rep.Seconds, "before_seconds", rep.BeforeSeconds))
	if len(rep.Defects) > 0 {
		o.fail(fmt.Sprintf("visual check failed: %d defect(s). Fix each one (report: %s):\n%s", len(rep.Defects), filepath.Join(outDir, "report.json"), strings.Join(rep.Summary, "\n")))
		return vis, "", nil, true
	}
	if len(p.mine) > 0 && p.cfg.Review != "off" && p.cfg.Screenshots != "off" && len(rep.Shots) > 0 {
		in := visual.ReviewInput{Change: e.O.Change, Task: st.Task.Label, Attempt: st.Attempts + 1, MaxAttempts: e.O.MaxAttempts,
			Root: e.R.Specs, ChangeDir: changeDir, Code: e.code, Scenarios: p.mine}
		if dm := filepath.Join(changeDir, "design-map.md"); exists(dm) {
			in.DesignMap = dm
		}
		for _, s := range p.mine {
			if len(s.References) > 0 {
				rubric = append(rubric, s.ID)
			}
		}
		b, _ := json.Marshal(rep.Pairs)
		_ = json.Unmarshal(b, &in.Pairs)
		b, _ = json.Marshal(rep.ARIAChanges)
		_ = json.Unmarshal(b, &in.AriaChanges)
		prompt := visual.ReviewPrompt(in)
		review = filepath.Join(outDir, "review-prompt.md")
		_ = os.WriteFile(review, []byte(prompt), 0o644)
	}
	return vis, review, rubric, false
}

// ---------- reject ----------

type rejectInfo struct {
	blocked  bool
	seconds  float64
	checks   []any
	visual   *Obj
	warnings []string
	event    string
	metric   *Obj
}

// reject restores tasks.md, counts the attempt, logs, prints and exits (check and review).
func (e *Env) reject(run string, st *State, failures []string, x rejectInfo) error {
	restore(st)
	st.Review = nil
	st.Attempts++
	lf := strings.Join(failures, "\n")
	if len(lf) > tailMax {
		lf = lf[len(lf)-tailMax:]
	}
	st.LastFailure = &lf
	exhausted, n := st.Attempts >= e.O.MaxAttempts, st.Attempts
	t := st.Task
	fp := fingerprint(x.checks, failures)
	t.Fingerprints = append(t.Fingerprints, fp)
	t.NoStatus = e.O.Reported == "none"
	repeat := ""
	if k := len(t.Fingerprints); fp != "" && k >= 2 && t.Fingerprints[k-2] == fp {
		repeat = fp
	}
	if repeat != "" && !exhausted && !x.blocked {
		// the same failure twice: the approach is ruled out; the next attempt is the last and starts over
		t.RuledOut = repeat
		st.Attempts = max(st.Attempts, e.O.MaxAttempts-1)
		t.OldDiff = e.startOver(st)
	}
	if exhausted {
		st.Exhausted = true
	}
	if st.lane != nil && x.blocked {
		st.lane.Status = laneBlocked
	}
	writeState(run, st)
	ev := x.event
	if ev == "" {
		ev = "check"
	}
	var firsts []string
	for _, f := range failures {
		firsts = append(firsts, firstLine(f))
	}
	logMetric(run, O("event", ev, "task", st.Task.Label, "attempt", n, "fingerprint", fp, "repeat", repeat != "", "ok", false, "blocked", x.blocked, "exhausted", exhausted, "seconds", x.seconds, "checks", x.checks, "failures", firsts).Merge(x.metric))
	result, code := "failed", Fail
	switch {
	case x.blocked:
		result, code = "blocked", Blocked
	case exhausted:
		result, code = "exhausted", Exhausted
	}
	out := O("result", result, "task", st.Task.Label, "attempt", n, "max_attempts", e.O.MaxAttempts, "failures", failures, "reverted", true, "checks", x.checks, "visual", If(x.visual != nil, x.visual), "warnings", If(x.warnings != nil, x.warnings))
	switch {
	case repeat != "" && exhausted:
		out.Set("repeated", repeat).Set("stopped", fmt.Sprintf("attempts %d and %d failed the same way; another attempt would repeat it. Stop and report to the user: this failure, the attempt note (%s) and what was ruled out", n-1, n, rel(e.code, e.notePath(t.Label))))
	case repeat != "":
		out.Set("repeated", repeat).Set("next_attempt", fmt.Sprintf("attempt %d of %d is the last: it starts over from the task's pre-task files with a different approach", st.Attempts+1, e.O.MaxAttempts))
	}
	if st.lane != nil {
		out.Set("wave", waveObj(st))
		if others := st.otherOpenLanes(); len(others) > 0 && (x.blocked || exhausted) {
			out.Set("next", fmt.Sprintf("only task %s stops; check the other tasks of the wave (%s) as their subagents return", st.Task.Label, strings.Join(others, ", ")))
		}
	}
	if x.blocked && len(st.otherOpenLanes()) == 0 {
		closeRun(e, run, result)
	}
	e.emit(out)
	return quit(code)
}

// ---------- review ----------

// Review records the spec-visual-reviewer's verdict (after check exit 5).
func (e *Env) Review() error {
	if _, err := e.changeDir(); err != nil {
		return err
	}
	if e.O.Reply == "" && e.O.Reviewer != "none" {
		return die(Usage, "review needs --reply FILE (the reviewer's reply; - reads stdin)")
	}
	if err := e.Begin(); err != nil {
		return err
	}
	run := e.currentRun(false)
	if run == "" || !exists(filepath.Join(run, "state.json")) {
		return die(Usage, "no task in progress: run `next` first")
	}
	st, err := readState(run)
	if err == nil && st.Wave != nil {
		if st, err = e.pickLane(st, true); err != nil {
			return err
		}
	}
	if err != nil || st.Review == nil || st.Task == nil {
		return die(Usage, "no visual review is pending (only `check` exit 5 asks for one)")
	}
	text := "STATUS: pass\n"
	if e.O.Reviewer != "none" {
		var b []byte
		if e.O.Reply == "-" {
			b, err = io.ReadAll(e.Stdin)
		} else {
			b, err = os.ReadFile(e.O.Reply)
		}
		if err != nil {
			return die(Usage, "cannot read the reply %s: %v", e.O.Reply, err)
		}
		text = string(b)
	}
	status, defects := parseReview(text)
	switch {
	case status == "":
		return die(Usage, "the reply has no `STATUS: pass` or `STATUS: fail` line; ask the reviewer again (nothing was recorded)")
	case status == "error":
		return die(Usage, "the reviewer could not review the screenshots (STATUS: error); dispatch it again, or, if no independent reviewer can run, record the review as skipped with `review <change> --reviewer none` (nothing was recorded)")
	case status == "fail" && len(defects) == 0:
		return die(Usage, "the reply says STATUS: fail but lists no `DEFECT:` line, so the implementer would have nothing to fix; ask the reviewer again (nothing was recorded)")
	}
	var rubricLog []string
	if e.O.Reviewer != "none" && len(st.Review.Rubric) > 0 {
		var rr struct{ Problems, Parsed []string }
		rr.Problems = visual.RubricProblems(text, st.Review.Rubric, status, defects)
		for _, x := range visual.ParseRubric(text) {
			rr.Parsed = append(rr.Parsed, fmt.Sprintf("%s %s:%s", x.Scenario, x.Item, x.Verdict))
		}
		if n := len(rr.Problems); n > 0 {
			more := ""
			if n > 4 {
				more = fmt.Sprintf("; +%d more", n-4)
			}
			return die(Usage, "the reply's design rubric is incomplete (%s%s): every scenario with a design reference needs one `RUBRIC: <scenario id> <item>: pass|fail - <what you compared>` line per item (see the review prompt); ask the reviewer again (nothing was recorded)", strings.Join(rr.Problems[:min(4, n)], "; "), more)
		}
		rubricLog = rr.Parsed
	}
	started, _ := time.Parse(time.RFC3339Nano, st.Review.Started)
	secs := time.Since(started).Seconds()
	ok := status == "pass" && len(defects) == 0
	rv := O("check", "visual_review", "ok", ok, "reviewer", e.O.Reviewer, "defects", len(defects), "seconds", secs)
	if rubricLog != nil {
		rv.Set("rubric", rubricLog)
	}
	checks := append(list(st.Review.Checks), rv)
	if ok {
		m := O("event", "review", "task", st.Task.Label, "attempt", st.Attempts+1, "ok", true, "reviewer", e.O.Reviewer, "skipped", If(e.O.Reviewer == "none", true), "seconds", secs)
		if rubricLog != nil {
			m.Set("rubric", rubricLog)
		}
		logMetric(run, m)
		return e.pass(run, st, checks, nil, nil, "")
	}
	metric := O("reviewer", e.O.Reviewer)
	if rubricLog != nil {
		metric.Set("rubric", rubricLog)
	}
	failure := fmt.Sprintf("visual review failed (spec-visual-reviewer): %d defect(s). Fix each one (area images: %s):\n%s", len(defects), filepath.Join(st.Review.Dir, "areas"), bullets(defects))
	return e.reject(run, st, []string{failure}, rejectInfo{event: "review", seconds: secs, checks: checks, metric: metric})
}

var (
	statusRE = regexp.MustCompile(`(?im)^\s*STATUS:\s*(pass|fail|error)\b`)
	defectRE = regexp.MustCompile(`(?m)^\s*(?:[-*]\s*)?DEFECT:\s*(.+?)\s*$`)
)

// parseReview reads the reviewer's reply: the last STATUS line and every DEFECT line.
func parseReview(text string) (string, []string) {
	st := ""
	if m := statusRE.FindAllStringSubmatch(text, -1); len(m) > 0 {
		st = strings.ToLower(m[len(m)-1][1])
	}
	defects := []string{}
	for _, m := range defectRE.FindAllStringSubmatch(text, -1) {
		defects = append(defects, m[1])
	}
	return st, defects
}
