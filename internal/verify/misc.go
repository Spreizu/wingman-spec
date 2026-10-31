package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/trace"
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
	if run != "" && exists(filepath.Join(run, "state.json")) {
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
	case len(rep.Defects) > 0:
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
	case len(rep.Defects) > 0:
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
	if !exists(tasksFile(changeDir)) {
		return nil, nil
	}
	ts, prog, err := loadTasks(changeDir)
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
	if run != "" && exists(filepath.Join(run, "state.json")) {
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
	return O("progress", prog, "next", next, "run", runAny, "run_status", runStatus, "last_finish", runstate.FinishLine(fin, runstate.Fingerprinted(e.code, true)),
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
func (e *Env) Anchors() error {
	md := trace.Mode(e.Cfg)
	dir := filepath.Join(e.R.Specs, ".none")
	if e.O.Change != "" {
		d, err := e.changeDir()
		if err != nil {
			return err
		}
		dir = d
	}
	r := e.tr().AnchorLint(dir)
	m := md
	if m == "off" {
		m = "on"
	}
	problems := list(trace.BySeverity(r.Problems, m))
	bad := slices.ContainsFunc(problems, func(p trace.Problem) bool { return p.Severity == "error" })
	reqs := O()
	keys := make([]string, 0, len(r.Facts.Requirements))
	for k := range r.Facts.Requirements {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if e.O.Change != "" && !slices.Contains(r.Mine, k) {
			continue
		}
		x := r.Facts.Requirements[k]
		reqs.Set(k, O("code", sortedKeys(x.Code), "tests", sortedKeys(x.Tests)))
	}
	var index any = Skip
	if e.O.JSON {
		index = trace.AnchorIndex(r.Eff, r.Facts)
	}
	e.print(O("ok", !bad, "mode", md, "summary", r.Summary, "problems", problems, "index", index, "requirements", reqs))
	if bad {
		return quit(Fail)
	}
	return nil
}

func sortedKeys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

var selectRE = regexp.MustCompile(`^(.*):(\d+)$`)

// AnchorsPrune lists (or with --apply removes) the markers anchor_fit flags as removable; the last code anchor stays.
func (e *Env) AnchorsPrune() error {
	tr := e.tr()
	fit, level := tr.FitProblems(nil, nil)
	left := map[string]int{}
	for _, m := range tr.ScanAnchors(nil) {
		if !testpaths.IsTestPath(m.File) {
			left[m.Key]++
		}
	}
	type cand struct {
		anchors.FitFinding
		none bool
	}
	var cands []cand
	if len(e.O.Select) > 0 {
		for _, s := range e.O.Select {
			m := selectRE.FindStringSubmatch(s)
			if m == nil {
				return die(Usage, "--select wants <file>:<line>, got '%s'", s)
			}
			line := toInt(m[2])
			i := slices.IndexFunc(fit, func(f anchors.FitFinding) bool { return f.File == m[1] && f.Line == line })
			if i < 0 {
				cands = append(cands, cand{anchors.FitFinding{File: m[1], Line: line}, true})
			} else {
				cands = append(cands, cand{fit[i], false})
			}
		}
	} else {
		for _, f := range fit {
			if f.Remove {
				cands = append(cands, cand{f, false})
			}
		}
	}
	var picks []anchors.RemovePick
	removable := []any{}
	refused := []any{}
	for _, x := range cands {
		why := ""
		switch {
		case x.none:
			refused = append(refused, O("file", x.File, "line", x.Line, "why", "not an over-anchored marker (anchor_fit has no finding there)"))
			continue
		case x.Kind == "many-anchors":
			why = "an info line about the count, not a marker to remove: anchors that pass the fit stay"
		case !x.Remove:
			why = "it is the requirement's only code anchor: move it, do not remove it"
		case left[x.Key] <= 1:
			why = "would leave the requirement without a code anchor"
		}
		if why != "" {
			refused = append(refused, O("file", x.File, "line", x.Line, "key", x.Key, "why", why))
			continue
		}
		left[x.Key]--
		picks = append(picks, anchors.RemovePick{File: x.File, Line: x.Line, Key: x.Key})
		removable = append(removable, O("file", x.File, "line", x.Line, "key", x.Key, "kind", x.Kind))
	}
	texts := map[string]string{}
	for _, p := range picks {
		if _, ok := texts[p.File]; !ok {
			texts[p.File] = readText(filepath.Join(e.code, p.File))
		}
	}
	removed := 0
	if e.O.Apply {
		for f, t := range anchors.RemoveMarkers(texts, picks) {
			if t == texts[f] {
				continue
			}
			if err := os.WriteFile(filepath.Join(e.code, f), []byte(t), 0o644); err != nil {
				return die(Fail, "cannot write %s: %v", f, err)
			}
			for _, p := range picks {
				if p.File == f {
					removed++
				}
			}
		}
	}
	note := "nothing changed: add --apply to remove these markers (or --select file:line,... to pick)"
	if e.O.Apply {
		note = "marker lines removed; run `wingman-spec drift` to see what is left"
	}
	e.print(O("ok", true, "level", level, "applied", e.O.Apply, "removable", removable, "removed", removed, "refused", refused, "note", note))
	return nil
}

// Guard is the anchor guard over the change's diff (base: --base, else the commit `next` recorded, else HEAD).
func (e *Env) Guard() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	base := e.O.Base
	if base == "" {
		base = e.changeBase()
	}
	if base == "" {
		base = "HEAD"
	}
	rep, lvl := e.guardReport(changeDir, base, "change", nil)
	if rep == nil {
		e.print(O("ok", true, "level", "off", "note", "anchor guard is off (anchor_guard: off or traceability: off)"))
		return nil
	}
	bad := lvl == "error" && len(rep.Findings) > 0
	e.print(O("ok", !bad, "level", lvl, "base", base, "files", list(rep.Files), "findings", list(rep.Findings)))
	if bad {
		return quit(Fail)
	}
	return nil
}

func isErrGap(g trace.Gap) bool { return g.Severity == "" || g.Severity == "error" }

func driftText(r trace.DriftReport) string {
	var errs, adv []trace.Gap
	for _, g := range r.Open {
		if isErrGap(g) {
			errs = append(errs, g)
		} else {
			adv = append(adv, g)
		}
	}
	hint := func(g trace.Gap) string {
		if g.Hint == "" {
			return ""
		}
		return "\n           hint: " + g.Hint
	}
	l := []string{fmt.Sprintf("drift: %d requirement(s); %d open gap(s) (+%d advisory), %d accepted", r.Requirements, len(errs), len(adv), len(r.Accepted))}
	for _, g := range errs {
		l = append(l, fmt.Sprintf("  OPEN     %s\n           %s%s", g.Key, g.Text, hint(g)))
	}
	for _, g := range adv {
		l = append(l, fmt.Sprintf("  %-8s %s  (advisory: does not fail drift)\n           %s%s", strings.ToUpper(g.Severity), g.Key, g.Text, hint(g)))
	}
	for _, n := range r.Notes {
		l = append(l, "  note: "+n)
	}
	if n := r.Observed["entries"]; n > 0 {
		w := "entries"
		if n == 1 {
			w = "entry"
		}
		l = append(l, fmt.Sprintf("  observed, unconfirmed: %d open %s in %d file(s) under observed/ (each waits for its owner; none is a requirement)", n, w, r.Observed["files"]))
	}
	for _, g := range r.Accepted {
		l = append(l, fmt.Sprintf("  accepted %s  (%s)", g.Key, g.Accepted))
	}
	return strings.Join(l, "\n")
}

func gapObj(g trace.Gap) *Obj {
	return O("key", g.Key, "type", g.Type, "severity", If(!isErrGap(g), g.Severity), "accepted", If(g.Accepted != "", g.Accepted), "text", g.Text,
		"hint", If(g.Hint != "", g.Hint), "files", NonEmpty(g.Files), "line", If(g.Type == "over-anchored", g.Line), "fit", If(g.Fit != "", g.Fit), "removable", If(g.Removable, true))
}

// Drift reports the gaps between the living specs, the code anchors and the test tags (--text: a readable list).
func (e *Env) Drift() error {
	md := trace.Mode(e.Cfg)
	r := e.tr().Drift("", false)
	var errs, adv []any
	for _, g := range r.Open {
		if isErrGap(g) {
			errs = append(errs, gapObj(g))
		} else {
			adv = append(adv, gapObj(g))
		}
	}
	acc := []any{}
	for _, g := range r.Accepted {
		acc = append(acc, gapObj(g))
	}
	if e.O.Text {
		fmt.Fprintln(e.Out, driftText(r))
	} else {
		next := "no drift"
		if len(errs) > 0 {
			next = "run /spec-garden: fix each gap by its hint, or accept the ones that belong to a requirement (`wingman-spec drift decide <key> --accept --note \"why\"`)"
		}
		var obs any = Skip
		if r.Observed["entries"] > 0 {
			obs = r.Observed
		}
		e.print(O("ok", len(errs) == 0, "mode", md, "requirements", r.Requirements, "counts", r.Counts, "observed", obs, "open", list(errs), "advisory", NonEmpty(adv),
			"notes", NonEmpty(r.Notes), "accepted", acc, "next", next))
	}
	if len(errs) > 0 {
		return quit(Fail)
	}
	return nil
}

// DriftDecide records an accepted gap (`Accepted:` on its requirement): one key, or --all <type>.
func (e *Env) DriftDecide() error {
	if !e.O.Accept {
		return die(Usage, "drift decide only records `--accept --note TEXT`: a gap you do not accept is fixed (the hint of each gap in `drift` says how)")
	}
	if e.O.All == "" && e.O.Key == "" {
		return die(Usage, "drift decide <gap-key> --accept --note TEXT   (gap keys: see `drift`); or --all <gap-type> --accept --note TEXT to accept every open gap of one type, e.g. --all unanchored-requirement")
	}
	if e.O.All != "" && !slices.Contains(trace.Acceptable, e.O.All) {
		return die(Usage, "only %s gaps can be accepted; a %s gap is fixed or removed (see its hint in `drift`)", strings.Join(trace.Acceptable, ", "), e.O.All)
	}
	tr := e.tr()
	rep := tr.Drift("", false)
	var gaps []trace.Gap
	if e.O.All != "" {
		for _, g := range rep.Open {
			if g.Type == e.O.All {
				gaps = append(gaps, g)
			}
		}
	} else {
		for _, g := range rep.Gaps {
			if g.Key == e.O.Key {
				gaps = append(gaps, g)
			}
		}
		if len(gaps) == 0 {
			return die(Usage, "no gap '%s' (keys look like unanchored-requirement:todo/add-a-todo; run `drift`)", e.O.Key)
		}
	}
	res, err := tr.Accept(gaps, e.O.Note)
	if err != nil {
		return die(Usage, "%v", err)
	}
	changed := 0
	unchanged := false
	for _, x := range res {
		if x.Changed {
			changed++
		} else {
			unchanged = true
		}
	}
	next := "commit the spec change; the gaps are listed as accepted"
	if unchanged && slices.ContainsFunc(gaps, func(g trace.Gap) bool { return g.Type == "stale-anchor" }) {
		next = "a stale-anchor clears when the requirement text changes in a commit: this line was already there with this reason; use a new reason"
	}
	e.print(O("accepted", list(res), "changed", changed, "next", next))
	return nil
}

// SyncReport is `sync --check`: specs merged, ADRs promoted and (traceability on) anchors and drift.
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
	next := fmt.Sprintf("archive with /spec-archive %s (it syncs first; `wingman-spec archive %s` archives only a synced change)", e.O.Change, e.O.Change)
	if !r.OK {
		next = fmt.Sprintf("NOT SYNCED: /spec-archive %s syncs first (merges the delta specs, promotes the ADRs) and stops at the problems listed. Run /spec-sync %s on its own only to inspect or fix them. Do not archive by hand.", e.O.Change, e.O.Change)
	}
	return O("synced", r.OK, "mode", trace.Mode(e.Cfg), "parts", r.Parts, "problems", list(r.Problems), "warnings", list(r.Warnings), "next", next), r.OK, nil
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

// Archive moves a finished, fully synced change to the archive and keeps its timeline and archived.json there.
func (e *Env) Archive() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	if exists(filepath.Join(changeDir, "BLOCKED.md")) {
		e.print(O("result", "refused", "problem", "BLOCKED.md exists: run /spec-fix first"))
		return quit(Blocked)
	}
	if exists(tasksFile(changeDir)) {
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
			e.print(O("result", "refused", "problem", fmt.Sprintf("%d task(s) are not done: finish /spec-apply (or /spec-fix) first", len(open)), "tasks", open))
			return quit(Fail)
		}
	}
	sr, ok, err := e.SyncReport()
	if err != nil {
		return err
	}
	if !ok {
		probs, _ := sr.Get("problems").([]string)
		e.say("REFUSED: change '%s' is NOT SYNCED, so it is not archived. %d problem(s):\n  - %s\n/spec-archive runs /spec-sync itself first; this refusal comes from calling the CLI directly. Run /spec-sync %s on its own only to inspect or fix the problem(s) above.", e.O.Change, len(probs), strings.Join(probs, "\n  - "), e.O.Change)
		x := O("result", "refused")
		x.Merge(sr)
		e.print(x)
		return quit(Fail)
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
	e.print(O("result", "archived", "dir", dst, "archived_at", rec.ArchivedAt, "timeline_head", timeline.Verify(filepath.Join(dst, timeline.File)).Head, "sync", sr.Get("parts"), "warnings", sr.Get("warnings"), "next", "the archive move is left uncommitted for you to review"))
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
