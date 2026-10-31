package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/trace"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

type finishState struct {
	Attempts    int      `json:"attempts"`
	LastFailure []string `json:"last_failure,omitempty"`
}

// Begin is what next, check, review and finish do first: take the change lock, record any decision, log the start.
func (e *Env) Begin() error {
	if err := e.guardRun(); err != nil {
		return err
	}
	if e.O.Cmd == "review" {
		return nil
	}
	task := ""
	wave, lane := 0, 0
	if run := e.currentRun(false); run != "" {
		if st, err := readState(run); err == nil && st.Task != nil {
			task = st.Task.Label
		} else if err == nil && st.Wave != nil && e.O.Task != "" {
			if i, l := st.Wave.lane(e.O.Task); l != nil {
				task, wave, lane = e.O.Task, st.Wave.N, i+1
			}
		}
	}
	e.decide(task)
	switch e.O.Cmd {
	case "check":
		sum := "checking the task"
		if task != "" {
			sum = "checking " + task
		}
		e.tl(timeline.Event{Event: "check-start", Task: task, Summary: sum, Wave: wave, Lane: lane})
	case "finish":
		e.tl(timeline.Event{Event: "finish-start", Summary: "verifying the whole change"})
	}
	return nil
}

func rel(base, f string) string {
	if r, err := filepath.Rel(base, f); err == nil && !strings.HasPrefix(r, "..") {
		if r == "" {
			return "."
		}
		return r
	}
	return f
}

// Finish is the deterministic close-out once every task is ticked: full project commands, validate, the visual check of
// every scenario of the change, the trace check, source-text and token rules, why, anchors, the guard and test evidence.
func (e *Env) Finish() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	if err := e.Begin(); err != nil {
		return err
	}
	if b := filepath.Join(changeDir, "BLOCKED.md"); exists(b) {
		e.emit(O("result", "blocked", "blocked_file", b))
		return quit(Blocked)
	}
	ts, _, err := loadTasks(changeDir)
	if err != nil {
		return err
	}
	var open []string
	for _, t := range ts {
		if !t.Done {
			open = append(open, t.Desc)
		}
	}
	if len(open) > 0 {
		e.emit(O("result", "tasks-open", "remaining", open, "fix", "finish runs after the last task: keep running next/check until next exits 10"))
		return quit(Usage)
	}
	tinfo := e.testCmd()
	if p := testCmdProblem(tinfo); p != "" {
		return die(Usage, "REFUSED: %s", p)
	}
	base := e.runsDir()
	fstate := filepath.Join(base, "finish.json")
	var fs0 finishState
	runstate.ReadJSON(fstate, &fs0)
	if fs0.Attempts >= e.O.MaxAttempts {
		e.emit(O("result", "exhausted", "attempts", fs0.Attempts, "last_failure", fs0.LastFailure, "fix", "stop and report to the user; delete "+rel(e.code, fstate)+" to allow new attempts"))
		return quit(Exhausted)
	}
	var prev runstate.Record
	previous := ""
	if runstate.ReadJSON(filepath.Join(base, "finished.json"), &prev) {
		previous = fmt.Sprintf("an earlier finish: %s; this run checks everything again", runstate.FinishLine(&prev, runstate.Fingerprinted(e.code, true)))
		e.say("%s", previous)
	}
	var runs []string
	ents, _ := os.ReadDir(base)
	for _, d := range ents {
		if d.IsDir() && exists(filepath.Join(base, d.Name(), "metrics.jsonl")) {
			runs = append(runs, d.Name())
		}
	}
	slices.Sort(runs)
	run := ""
	if len(runs) > 0 {
		run = filepath.Join(base, runs[len(runs)-1])
	} else {
		run = e.currentRun(true)
	}
	t0 := time.Now()
	var o outcome
	type job struct{ name, cmd string }
	var jobs []job
	if tinfo.Cmd != nil {
		jobs = append(jobs, job{"tests", tinfo.cmd()})
	} else {
		o.warn("project tests were not run (commands.test: none)")
	}
	for _, x := range e.extraCmds() {
		if x.Cmd != nil {
			jobs = append(jobs, job{x.Name, x.cmd()})
		} else if x.State == "placeholder" {
			o.warn(fmt.Sprintf("commands.%s is still <fill in>: %s was not run", x.Name, x.Name))
		}
	}
	tree := ""
	if len(jobs) > 0 {
		tree = e.phaseTree()
	}
	results := make([]Result, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Go(func() { results[i] = e.runNamed(j.name, j.cmd, tree) })
	}
	var vrep []string
	vt0 := time.Now()
	vrep, verr := validateChange(e.R, e.O.Change)
	vsecs := time.Since(vt0).Seconds()
	wg.Wait()
	e.memo = nil
	testOut := ""
	ranTests := false
	for i, j := range jobs {
		r := results[i]
		if j.name == "tests" {
			testOut, ranTests = r.Full, true
		}
		x := O("check", j.name, "ok", r.RC == 0, "rc", r.RC, "timed_out", r.TimedOut, "seconds", r.Seconds)
		if r.Cached {
			x.Set("cached", true)
		}
		o.check(x)
		if r.RC != 0 {
			t := r.Tail
			if len(t) > 1500 {
				t = t[len(t)-1500:]
			}
			o.fail(failText(j.name, r) + "\n" + t)
		}
	}
	switch {
	case verr != nil:
		o.check(O("check", "validate", "ok", false, "seconds", vsecs))
		o.fail("validate failed: " + verr.Error())
	case len(vrep) > 0:
		o.check(O("check", "validate", "ok", false, "rc", 1, "seconds", vsecs))
		o.fail(fmt.Sprintf("validate failed (exit 1): wingman-spec validate %s\n%s", e.O.Change, strings.Join(vrep, "\n")))
	default:
		o.check(O("check", "validate", "ok", true, "rc", 0, "seconds", vsecs))
	}
	e.finishVisual(changeDir, run, &o)
	// trace: every scenario of the change has a tagged test (visual ones are covered by the visual check)
	tq0 := time.Now()
	scens := quality.SpecScenarios(filepath.Join(changeDir, "specs"))
	res := runstate.Timed("scan: traceability", func() quality.TraceResult {
		return quality.Trace(scens, quality.TraceTags(quality.ListTestFiles(e.code), e.code), !e.Cfg.Visual.Off)
	})
	var untested []string
	for _, s := range res.Missing {
		untested = append(untested, s.ID)
	}
	o.check(O("check", "trace", "ok", len(untested) == 0, "scenarios", res.Total, "tagged", len(res.Covered), "visual", len(res.Visual), "untested", list(untested), "seconds", time.Since(tq0).Seconds()))
	if len(untested) > 0 {
		o.fail(fmt.Sprintf("%d of %d scenarios have no tagged test: %s. Write (or tag) a test that proves each one. %s", len(untested), res.Total, bracket(untested), tagHelp))
	}
	up := runstate.Timed("scan: path and scope", func() []string { return e.checkScope(changeDir) })
	var pathProbs []string
	for _, p := range e.sizeReport(changeDir).Problems {
		if p.Kind == "path-artifacts" {
			pathProbs = append(pathProbs, p.Text)
		}
	}
	pc := O("check", "path", "ok", len(pathProbs) == 0, "path", quality.PlanPath(quality.SizeFacts(changeDir, e.readUpgrade())).Path)
	if len(up) > 0 {
		pc.Set("upgraded_by", up)
	}
	o.check(pc)
	for _, p := range pathProbs {
		o.fail(p)
	}
	cbase := e.changeBase()
	var touched []string
	if cbase != "" {
		touched = e.changedTestFiles(cbase)
	}
	stFiles := touched
	if stFiles == nil {
		stFiles = quality.ListTestFiles(e.code)
	}
	var bad, allowed []string
	runstate.Timed("scan: source-text tests", func() bool { bad, allowed = e.sourceTextCheck(stFiles); return true })
	scope := "all test files (no recorded base commit: warn only)"
	if touched != nil {
		scope = "test files changed since " + cbase[:min(12, len(cbase))]
	}
	o.check(O("check", "source_text", "ok", touched == nil || len(bad) == 0, "files", len(touched), "findings", len(bad), "allowed", len(allowed), "scope", scope))
	switch {
	case len(bad) > 0 && touched != nil:
		o.fail("tests read source files as text:\n" + bullets(bad) + "\n" + quality.SourceTextFix)
	case len(bad) > 0:
		for _, b := range bad {
			o.warn("source-text test (pre-existing?): " + b)
		}
	}
	for _, a := range allowed {
		o.warn("allowed source-text test: " + a)
	}
	if cbase != "" {
		if now := e.changedFiles(); now != nil {
			o.addTokenLint(runstate.Timed("scan: design tokens", func() *tokenResult {
				return e.tokenLint(changeDir, uniq(append(gitx.Lines(e.code, "diff", "--name-only", cbase, "--"), now...)))
			}))
		}
	}
	nr := runstate.Timed("scan: why", func() whyRep { return e.whyReport(changeDir) })
	if nr.mode != "off" {
		var keys []string
		for _, a := range nr.Approvals {
			keys = append(keys, a.Key)
		}
		o.check(O("check", "why", "ok", !slices.ContainsFunc(nr.Problems, func(p trace.Problem) bool { return p.Severity == "error" }), "why_owner_approval", list(keys)))
		for _, p := range nr.Problems {
			if p.Severity == "error" {
				o.fail("why: " + p.Text)
			} else {
				o.warn("why: " + p.Text)
			}
		}
		ar := runstate.Timed("scan: anchors", func() trace.LintResult { return e.tr().AnchorLint(changeDir) })
		aps := trace.BySeverity(ar.Problems, nr.mode)
		sm := ar.Summary
		o.check(O("check", "anchors", "ok", !slices.ContainsFunc(aps, func(p trace.Problem) bool { return p.Severity == "error" }), "requirements", sm["change_requirements"],
			"without_code_anchor", sm["without_code"], "without_test_anchor", sm["without_test"], "unresolved", sm["unresolved"], "stale_tags", sm["stale_tags"]))
		for _, p := range aps {
			if p.Severity == "error" {
				o.fail("code anchors: " + p.Text)
			} else {
				o.warn("code anchors: " + p.Text)
			}
		}
		var gr *anchors.GuardResult
		var glvl string
		runstate.Timed("scan: anchor guard (git blame)", func() bool { gr, glvl = e.guardReport(changeDir, cbase, "change", nil); return true })
		o.addGuard(gr, glvl, nr.mode)
		e.testEvidence(&o, ranTests, testOut, scens, len(untested) == 0)
	}
	secs := time.Since(t0).Seconds()
	for _, w := range o.warnings {
		e.say("WARNING: %s", w)
	}
	checks := list(o.checks)
	warnings := list(o.warnings)
	if len(o.failures) == 0 {
		logMetric(run, O("event", "finish", "ok", true, "attempt", fs0.Attempts+1, "seconds", secs, "checks", checks))
		_ = os.Remove(fstate)
		fp := runstate.Fingerprinted(e.code, true)
		var rr runstate.Run
		runstate.ReadJSON(filepath.Join(run, "run.json"), &rr)
		rec := runstate.Record{At: runstate.Now(), Run: filepath.Base(run), Session: rr.Session, Head: fp.Head, Branch: fp.Branch, Tree: fp.Tree, Worktree: e.code}
		_ = runstate.WriteJSON(filepath.Join(base, "finished.json"), rec)
		var appr any = Skip
		var akeys []string
		if len(nr.Approvals) > 0 {
			var xs []*Obj
			for _, a := range nr.Approvals {
				xs = append(xs, O("requirement", a.Key, "change", a.Status, "was", a.Was, "now", a.Now))
				akeys = append(akeys, a.Key)
			}
			appr = xs
		}
		next := fmt.Sprintf("commit, then tell the user: Run /spec-archive %s; it syncs first (specs, ADRs) and stops if the sync finds a problem.", e.O.Change)
		if len(akeys) > 0 {
			next += " This change rewrites a Why or removes a requirement: the owner must approve it (" + strings.Join(akeys, ", ") + ")."
		}
		e.emit(O("result", "finished", "status", runstate.FinishLine(&rec, fp), "previous_finish", If(previous != "", previous), "checks", checks, "seconds", secs, "warnings", warnings, "why_owner_approval", appr, "next", next))
		return nil
	}
	attempts := fs0.Attempts + 1
	exhausted := attempts >= e.O.MaxAttempts
	var firsts []string
	for _, f := range o.failures {
		firsts = append(firsts, firstLine(f))
	}
	_ = runstate.WriteJSON(fstate, finishState{attempts, firsts})
	logMetric(run, O("event", "finish", "ok", false, "attempt", attempts, "exhausted", exhausted, "seconds", secs, "checks", checks, "failures", firsts))
	fix := filepath.Join(run, fmt.Sprintf("finish-fix-%d.md", attempts))
	var b strings.Builder
	fmt.Fprintf(&b, "The change `%s` (change directory: `%s`) has every task ticked, but its finish check failed (attempt %d of %d).\n", e.O.Change, rel(e.code, changeDir), attempts, e.O.MaxAttempts)
	b.WriteString("Fix exactly these problems, test-first where a behaviour is missing a test:\n\n")
	for _, f := range o.failures {
		b.WriteString("- " + strings.ReplaceAll(f, "\n", "\n  ") + "\n")
	}
	var rd []string
	for _, f := range []string{"proposal.md", "specs", "design.md", "design-map.md", "tasks.md", "progress.md"} {
		if p := filepath.Join(changeDir, f); exists(p) {
			rd = append(rd, rel(e.code, p))
		}
	}
	fmt.Fprintf(&b, "\nRead first: %s.\n", strings.Join(rd, ", "))
	b.WriteString("The orchestrator re-runs the finish check after you. Do not edit tasks.md, specs or ADRs, and do not commit.\n")
	b.WriteString("If a problem cannot be fixed without changing the plan or the specs, write BLOCKED.md in the change directory instead.\n")
	b.WriteString("End your reply with one line: `STATUS: done`, `STATUS: failed` or `STATUS: blocked`.\n")
	_ = os.WriteFile(fix, []byte(b.String()), 0o644)
	result, next, code := "failed", "dispatch ONE spec-implementer subagent with fix_prompt, commit nothing, then run finish again", Fail
	var fp any = fix
	if exhausted {
		result, next, code, fp = "exhausted", "stop and report the failures to the user", Exhausted, nil
	}
	e.emit(O("result", result, "attempt", attempts, "max_attempts", e.O.MaxAttempts, "failures", o.failures, "fix_prompt", fp, "checks", checks, "seconds", secs, "warnings", warnings, "next", next))
	return quit(code)
}

// finishVisual checks every scenario of the change (defects only); with visual.scope: task also the living scenarios the
// change does not redefine, once, against HEAD.
func (e *Env) finishVisual(changeDir, run string, o *outcome) {
	cfg := e.Cfg.Visual
	if cfg.Off {
		return
	}
	vscens := e.scenarios(filepath.Join(changeDir, "specs"))
	var guards []*visual.Scenario
	if cfg.Scope == "task" && slices.ContainsFunc(e.changedFiles(), func(f string) bool { return visual.IsUIFile(f, cfg) }) {
		have := map[string]bool{}
		for _, s := range vscens {
			have[s.ID] = true
		}
		for _, s := range e.scenarios(e.R.LivingSpecs()) {
			if !have[s.ID] {
				guards = append(guards, s)
			}
		}
	}
	if len(vscens)+len(guards) == 0 {
		return
	}
	if vp := visual.ConfigProblem(cfg); vp != "" {
		o.fail(fmt.Sprintf("visual check needed (%d visual scenarios) but %s", len(vscens)+len(guards), vp))
		return
	}
	outDir := filepath.Join(run, "visual", "finish-"+stamp())
	declared := map[string]bool{}
	ts, _, _ := loadTasks(changeDir)
	for _, t := range ts {
		for _, f := range filesOf(t.T.Detail) {
			b := filepath.Base(f)
			declared[strings.ToLower(strings.TrimSuffix(b, filepath.Ext(b)))] = true
		}
	}
	p := vplan{cfg: cfg, mine: vscens}
	for _, s := range vscens {
		p.items = append(p.items, visual.Item{Scenario: s, Role: "task", InScope: true})
	}
	for _, s := range guards {
		p.items = append(p.items, visual.Item{Scenario: s, Role: "guard", InScope: s.Component != "" && declared[strings.ToLower(s.Component)]})
	}
	rep := runstate.Timed("visual check", func() vreport { return e.runVisual(changeDir, p, nil, run, outDir) })
	o.warn(rep.Warnings...)
	if rep.skipped() != "" {
		o.check(O("check", "visual", "ok", !cfg.RequirePlaywright, "skipped", rep.skipped(), "seconds", rep.Seconds))
		if cfg.RequirePlaywright {
			o.fail(fmt.Sprintf("visual check could not run (%s)", rep.skipped()))
		}
		return
	}
	o.check(O("check", "visual", "ok", len(rep.Defects) == 0, "defects", len(rep.Defects), "seconds", rep.Seconds))
	if len(rep.Defects) > 0 {
		o.fail(fmt.Sprintf("visual check: %d defect(s) (report: %s):\n%s", len(rep.Defects), filepath.Join(outDir, "report.json"), strings.Join(rep.Summary, "\n")))
	}
}

// testEvidence reads the finish test output: tagged scenarios must pass (failing or skipped fails finish).
func (e *Env) testEvidence(o *outcome, ran bool, out string, scens []*quality.Scenario, traced bool) {
	evl := trace.LevelsOf(e.Cfg).Evidence
	if !ran || evl == "off" || !traced {
		return
	}
	var sc []anchors.EvidenceScenario
	for _, s := range scens {
		if !s.Visual && s.Requirement != "" {
			sc = append(sc, anchors.EvidenceScenario{ID: s.ID, Requirement: s.Capability + "/" + spec.Slug(s.Requirement)})
		}
	}
	ev := anchors.TestEvidence(out, sc)
	var failed, unlisted, passed []string
	for _, s := range sc {
		switch ev.ByScenario[s.ID] {
		case "failed":
			failed = append(failed, s.ID)
		case "unlisted":
			unlisted = append(unlisted, s.ID)
		default:
			passed = append(passed, s.ID)
		}
	}
	strict := evl == "strict" && len(unlisted) > 0
	reqs := O()
	for _, k := range ev.Order {
		v := ev.ByRequirement[k]
		st := "unlisted"
		switch {
		case len(v.Failed) > 0:
			st = "failed"
		case len(v.Passed) > 0 && len(v.Unlisted) == 0:
			st = "passed"
		case len(v.Passed) > 0:
			st = "partly-listed"
		}
		reqs.Set(k, st)
	}
	o.check(O("check", "test_evidence", "ok", len(failed) == 0 && !strict, "passed", len(passed), "failed", list(failed), "unlisted", len(unlisted), "requirements", reqs))
	if len(failed) > 0 {
		o.fail(fmt.Sprintf("tests tagged for these scenarios are failing or skipped in the test output: %s. An anchored requirement needs a passing test of its scenarios: fix the test or the code (do not skip or delete the test).", bracket(failed)))
	}
	if len(unlisted) > 0 {
		more := ""
		if len(unlisted) > 6 {
			more = ", ..."
		}
		s := fmt.Sprintf("test evidence: the test output does not name %d tagged scenario(s) (%s%s), so passing cannot be confirmed from it; the test command exited 0. Use a reporter that prints test names for the finish run", len(unlisted), bracket(unlisted[:min(6, len(unlisted))]), more)
		if strict {
			o.fail(s + " (test_evidence: strict).")
		} else {
			o.warn(s + ".")
		}
	}
}
