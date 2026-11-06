package verify

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

// Visual is the implementer's self-check: the visual check of the task in progress (or --scenario ids), no gate.
func (e *Env) Visual() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	cfg := e.Cfg.Visual
	if p := visual.ConfigProblem(cfg); p != "" {
		return die(Usage, "REFUSED: %s", p)
	}
	if cfg.Off {
		e.print(O("result", "off", "note", "`visual: off` in the config"))
		return nil
	}
	vl := e.visualLint(changeDir)
	var bad []VProblem
	for _, p := range vl.problems {
		if p.severity() == "error" {
			bad = append(bad, p)
		}
	}
	if len(bad) > 0 {
		e.print(O("result", "visual-spec", "problems", bad))
		return quit(Usage)
	}
	scens := e.scenarios(filepath.Join(changeDir, "specs"))
	run := e.currentRun(false)
	var st *State
	if run != "" && layout.Exists(filepath.Join(run, "state.json")) {
		if s, err := readState(run); err == nil {
			st = s
		}
	}
	taskRun := st != nil && st.Task != nil && len(e.O.Scenarios) == 0
	var p vplan
	if taskRun {
		p = e.visualPlan(changeDir, st)
	} else {
		pick := scens
		if len(e.O.Scenarios) > 0 {
			found, unknown := resolveRefs(vrefs{ids: e.O.Scenarios}, scens)
			if len(unknown) > 0 {
				known := strings.Join(ids(scens), ", ")
				if known == "" {
					known = "none"
				}
				return die(Usage, "unknown scenario(s): %s (known: %s)", strings.Join(unknown, ", "), known)
			}
			pick = found
		}
		p = vplan{cfg: cfg, mine: pick}
		for _, s := range pick {
			p.items = append(p.items, visual.Item{Scenario: s, Role: "task", InScope: true, Shots: cfg.Screenshots != "off"})
		}
	}
	if len(p.items) == 0 {
		e.print(O("result", "none", "note", "no visual scenario to check"))
		return nil
	}
	base := run
	if base == "" {
		base = e.runsDir()
	}
	outDir := filepath.Join(base, "visual", "self-"+stamp())
	var pst *State
	if taskRun {
		pst = st
	}
	rep := runstate.Timed("visual check", func() vreport { return e.runVisual(changeDir, p, pst, base, outDir) })
	if taskRun && run != "" && len(st.VisualBefore) > 0 {
		writeState(run, st)
	}
	for _, w := range rep.Warnings {
		e.say("WARNING: %s", w)
	}
	result := "clean"
	switch {
	case rep.skipped() != "":
		result = "skipped"
	case rep.nDefects() > 0:
		result = "defects"
	}
	var labels []string
	for _, it := range p.items {
		labels = append(labels, fmt.Sprintf("%s (%s)", it.Scenario.ID, it.Role))
	}
	areas := rep.Pairs
	if len(areas) == 0 {
		areas = rep.Shots
	}
	e.print(O("result", result, "ignored", len(rep.Ignored), "ignored_report", NonEmpty(rep.IgnoredReport), "skipped_steps", NonEmpty(rep.SkippedSteps),
		"scenarios", labels, "before", rep.Before, "report", filepath.Join(outDir, "report.json"), "seconds", rep.Seconds,
		"defects", list(rep.Summary), "aria_changes", list(rep.ARIAChanges), "area_images", list(areas), "warnings", list(rep.Warnings)))
	switch {
	case rep.skipped() != "" && cfg.RequirePlaywright:
		return quit(Fail)
	case rep.skipped() != "":
		return quit(Usage)
	case rep.nDefects() > 0:
		return quit(Fail)
	}
	return nil
}

// RunStatus is where the apply loop of a change stands: progress, the next task, the open run, the last finish.
func (e *Env) RunStatus() (*Obj, error) {
	changeDir, err := e.changeDir()
	if err != nil {
		return nil, err
	}
	if !layout.Exists(tasksFile(changeDir)) {
		return nil, nil
	}
	ts, prog, err := e.loadTasks(changeDir)
	if err != nil {
		return nil, err
	}
	var next any
	for _, t := range ts {
		if !t.Done {
			next = t.Desc
			break
		}
	}
	run := e.currentRun(false)
	var st *State
	if run != "" && layout.Exists(filepath.Join(run, "state.json")) {
		st, _ = readState(run)
	}
	runStatus := "no open run"
	var rec runstate.Run
	if run != "" && runstate.ReadJSON(filepath.Join(run, "run.json"), &rec) {
		owner := "yours or unknown owner"
		if runstate.Owner(&rec, runstate.Me(e.O.Session, e.code), time.Now()).Foreign {
			owner = "NOT yours (another session or worktree)"
		}
		runStatus = runstate.Describe(&rec, time.Now(), false) + "; " + owner
	}
	var fin *runstate.Record
	var f runstate.Record
	if runstate.ReadJSON(filepath.Join(e.runsDir(), "finished.json"), &f) {
		fin = &f
	}
	led := e.readLedger(ts)
	verified := []string{}
	for k := range led.Passed {
		verified = append(verified, k)
	}
	slices.Sort(verified)
	var review any
	if st != nil && st.Review != nil {
		review = st.Review.Prompt
	}
	var runAny any
	if run != "" {
		runAny = run
	}
	return O("progress", prog, "next", next, "run", runAny, "run_status", runStatus, "last_finish", runstate.FinishLine(fin, e.code, runstate.Fingerprinted(e.code, true)),
		"verified", verified, "review_pending", review, "ambiguous", e.lintReport([]string{tasksFile(changeDir)})), nil
}

// Doctor checks the setup: the test command, the visual config, Playwright, Chromium, axe, the roles and local credentials.
func (e *Env) Doctor() error {
	var problems, warnings []string
	t := e.testCmd()
	if p := testCmdProblem(t); p != "" {
		problems = append(problems, p)
	}
	if t.State == "none" {
		warnings = append(warnings, "Test command: none — the verifier will not run project tests")
	}
	cfg := e.Cfg.Visual
	vp := visual.ConfigProblem(cfg)
	if vp != "" {
		problems = append(problems, vp)
	}
	var env any = O("playwright", nil, "chromium", nil, "browsers", nil, "axe", nil, "axe_tags", nil)
	roles := []any{}
	if !cfg.Off && vp == "" {
		var res struct {
			Env      map[string]any `json:"env"`
			Problems []string       `json:"problems"`
			Warnings []string       `json:"warnings"`
			Roles    []any          `json:"roles"`
		}
		if err := visual.Call(e.Ctx, e.code, "doctor", e.visualJob(nil), &res, nil); err != nil {
			msg := "the visual check cannot run: " + err.Error()
			if cfg.RequirePlaywright {
				problems = append(problems, msg)
			} else {
				warnings = append(warnings, msg+" (it will be SKIPPED)")
			}
		} else {
			env = res.Env
			problems = append(problems, res.Problems...)
			warnings = append(warnings, res.Warnings...)
			roles = list(res.Roles)
			for _, r := range res.Roles {
				m, _ := r.(map[string]any)
				if ready, _ := m["ready"].(bool); m != nil && !ready {
					var miss []string
					if xs, ok := m["missing"].([]any); ok {
						for _, x := range xs {
							miss = append(miss, fmt.Sprint(x))
						}
					}
					warnings = append(warnings, fmt.Sprintf("visual role %v: missing %s; scenarios with `role: %v` will fail until it is set", m["role"], strings.Join(miss, ", "), m["role"]))
				}
			}
		}
	}
	local := filepath.Join(".wingman-spec", "local")
	if tracked := gitx.Lines(e.code, "ls-files", "--", filepath.Join(local, "roles.yaml"), filepath.Join(local, "auth")); len(tracked) > 0 {
		problems = append(problems, fmt.Sprintf("credentials or sessions are tracked by git: %s; run git rm --cached on them, they must stay local (they are gitignored)", strings.Join(tracked, ", ")))
	}
	warnings = append(warnings, timelineProblems(e.R)...)
	extra := e.extraCmds()
	for _, x := range extra {
		if x.State == "placeholder" {
			warnings = append(warnings, fmt.Sprintf("commands.%s is still <fill in>: set it (e.g. `npm run %s`) or write none", x.Name, x.Name))
		}
	}
	var tc, lc any
	for _, x := range extra {
		switch x.Name {
		case "typecheck":
			tc = x
		case "lint":
			lc = x
		}
	}
	e.print(O("ok", len(problems) == 0, "root", e.R.Specs, "code_root", e.code, "test_command", t, "typecheck_command", tc, "lint_command", lc,
		"visual", O("off", cfg.Off, "command", orNil(cfg.Command), "url", orNil(cfg.URL), "review", cfg.Review, "require_playwright", cfg.RequirePlaywright, "ignore_https_errors", cfg.IgnoreHTTPSErrors, "roles", roles),
		"env", env, "problems", list(problems), "warnings", list(warnings)))
	if len(problems) > 0 {
		return quit(Fail)
	}
	return nil
}

// DesignSystem prints what the project already has to build a design with (tokens, components, variants).
func (e *Env) DesignSystem() error {
	var res struct {
		System any    `json:"system"`
		Text   string `json:"text"`
	}
	if err := visual.Call(e.Ctx, e.code, "design-system", map[string]any{"code_root": e.code}, &res, nil); err != nil {
		return die(Fail, "design-system: %v", err)
	}
	if e.O.JSON {
		e.print(res.System)
	} else {
		fmt.Fprintln(e.Out, res.Text)
	}
	return nil
}

// Anchors lists the code and test anchors of every requirement (or the change's), with their problems.
