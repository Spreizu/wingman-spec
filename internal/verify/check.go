package verify

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/trace"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

const tagHelp = "Put the scenario id in square brackets in the title of the test that proves it, e.g. it('[list-search/zero-matches] shows the empty state') or def test_zero_matches(): with a \"[list-search/zero-matches]\" docstring; the id is <capability>/<scenario name in kebab-case>."

var (
	openBoxRE = regexp.MustCompile(`^\s*[-*+]\s+\[ \]`)
	specLnRE  = regexp.MustCompile(`(?i)^Spec:\s*`)
	uiExtRE   = regexp.MustCompile(`\.(vue|jsx|tsx|svelte|astro|html?)$`)
)

func specLineOf(m Member) string {
	for _, d := range m.Details {
		if specLnRE.MatchString(d) {
			return specLnRE.ReplaceAllString(d, "")
		}
	}
	return ""
}

// specRefsOf are the scenario references of every Spec: line of the dispatch.
func specRefsOf(st *State, scens []*quality.Scenario) quality.Refs {
	var r quality.Refs
	for _, m := range st.members() {
		if l := specLineOf(m); l != "" {
			x := quality.SpecRefs(l, scens)
			r.Explicit = append(r.Explicit, x.Explicit...)
			r.Implicit = append(r.Implicit, x.Implicit...)
		}
	}
	return r
}

// tickTask ticks the dispatch's boxes (an agent that ticked them already changes nothing).
func (e *Env) tickTask(st *State) {
	for _, m := range st.members() {
		b, err := os.ReadFile(m.File)
		if err != nil {
			continue
		}
		lines := strings.Split(string(b), "\n")
		i := m.Line - 1
		if i >= 0 && i < len(lines) && openBoxRE.MatchString(lines[i]) {
			lines[i] = strings.Replace(lines[i], "[ ]", "[x]", 1)
			_ = os.WriteFile(m.File, []byte(strings.Join(lines, "\n")), 0o644)
			runstate.ForgetRead(m.File)
			e.mu.Lock()
			delete(e.plans, m.File)
			e.mu.Unlock()
		}
	}
}

func restore(st *State) {
	for _, s := range st.Snapshots {
		if b, err := os.ReadFile(s.Snap); err == nil {
			_ = os.WriteFile(s.File, b, 0o644)
			runstate.ForgetRead(s.File)
		}
	}
}

func isTarget(st *State, file string, line int) bool {
	for _, m := range st.members() {
		if m.File == file && m.Line == line {
			return true
		}
	}
	return false
}

// diffTasks lists every tasks.md edit except the dispatch's own ticks.
func diffTasks(st *State, files []string) []string {
	var out []string
	for _, s := range st.Snapshots {
		post, err := os.ReadFile(s.File)
		if err != nil {
			out = append(out, s.File+" was deleted")
			continue
		}
		preL := strings.Split(readText(s.Snap), "\n")
		postL := strings.Split(string(post), "\n")
		base := filepath.Base(s.File)
		if len(preL) != len(postL) {
			out = append(out, fmt.Sprintf("%s: line count changed %d -> %d (tasks or details added or deleted)", base, len(preL), len(postL)))
		}
		for i := 0; i < min(len(preL), len(postL)); i++ {
			if preL[i] == postL[i] {
				continue
			}
			if !isTarget(st, s.File, i+1) || postL[i] != strings.Replace(preL[i], "[ ]", "[x]", 1) {
				out = append(out, fmt.Sprintf("%s:%d changed: %q -> %q", base, i+1, strings.TrimSpace(preL[i]), strings.TrimSpace(postL[i])))
			}
		}
	}
	for _, f := range files {
		if !slices.ContainsFunc(st.Snapshots, func(s Snap) bool { return s.File == f }) {
			out = append(out, "new task file "+f)
		}
	}
	return out
}

// ---------- targeted tests ----------

var shqRE = regexp.MustCompile(`^[\w./@:+-]+$`)

func shq(f string) string {
	if shqRE.MatchString(f) {
		return f
	}
	return "'" + strings.ReplaceAll(f, "'", `'\''`) + "'"
}

type targeted struct {
	cmd, tpl, source, why string
	files                 []string
	counts                *Obj
}

func (e *Env) targetedTemplate(testCmd string) (tpl, source, why string) {
	if v, ok := os.LookupEnv("WINGMAN_SPEC_TARGETED_TEST_CMD"); ok {
		if v == "" {
			return "", "WINGMAN_SPEC_TARGETED_TEST_CMD", "WINGMAN_SPEC_TARGETED_TEST_CMD is empty"
		}
		return v, "WINGMAN_SPEC_TARGETED_TEST_CMD", ""
	}
	c := e.cmdInfo("targeted", "targeted", "\x00")
	switch c.State {
	case "set":
		return c.cmd(), c.Source, ""
	case "none":
		return "", c.Source, "commands.targeted: none"
	}
	t := testpaths.TargetedTemplate(testCmd, func(name string) string {
		var p struct{ Scripts map[string]string }
		runstate.ReadJSON(filepath.Join(e.code, "package.json"), &p)
		return p.Scripts[name]
	})
	if t == "" {
		return "", "", fmt.Sprintf("no targeted test command is known for `%s` (set `commands: targeted: <runner> {files}` in wingman-spec.yaml)", testCmd)
	}
	return t, "test command", ""
}

// changedTestFiles are the test files changed since base (committed or not); nil without git.
func (e *Env) changedTestFiles(base string) []string {
	now := e.changedFiles()
	if now == nil {
		return nil
	}
	var since []string
	if base != "" {
		since = e.namesSince(base)
	}
	out := []string{}
	for _, f := range uniq(append(since, now...)) {
		if testpaths.IsTestFile(f) && exists(filepath.Join(e.code, f)) {
			out = append(out, f)
		}
	}
	return out
}

func uniq(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// targetedTests: the test files changed since the change began, tagged with the task's scenarios, named after its sources.
func (e *Env) targetedTests(changeDir string, st *State, testCmd string, scens []*quality.Scenario) targeted {
	tpl, source, why := e.targetedTemplate(testCmd)
	if tpl == "" {
		return targeted{why: why}
	}
	all := e.testFiles()
	changed := e.changedTestFiles(e.changeBase())
	if st.lane != nil { // in a wave: only this task's tests; the other tasks' tests may be half-written
		mine := filesOf(st.Task.Details)
		changed = slices.DeleteFunc(changed, func(f string) bool { return !ownsAny(mine, f) && len(testpaths.TestsFor(mine, []string{f})) == 0 })
	}
	if scens == nil {
		scens = e.scenariosOf(changeDir)
	}
	refs := specRefsOf(st, scens)
	idset := map[string]bool{}
	for _, s := range append(refs.Explicit, refs.Implicit...) {
		idset[s.ID] = true
	}
	var tagged []string
	if len(idset) > 0 {
		tags := e.traceTags(all)
		for id := range idset {
			tagged = append(tagged, tags[id]...)
		}
	}
	var sources []string
	for _, m := range st.members() {
		sources = append(sources, filesOf(m.Details)...)
	}
	if st.lane == nil {
		sources = uniq(append(sources, e.changedFiles()...))
	}
	mapped := testpaths.TestsFor(sources, all)
	var files []string
	for _, f := range uniq(slices.Concat(changed, tagged, mapped)) {
		if exists(filepath.Join(e.code, f)) {
			files = append(files, f)
		}
	}
	slices.Sort(files)
	counts := O("changed", len(changed), "tagged", len(uniq(tagged)), "named_after_sources", len(mapped))
	if len(files) == 0 {
		return targeted{why: "no test file targets this task (none changed, tagged with its scenarios or named after its files); the full suite runs at finish", files: []string{}, counts: counts}
	}
	return targeted{cmd: testpaths.WithFiles(tpl, files), tpl: tpl, source: source, files: files, counts: counts}
}

// ---------- check level ----------

// endsGroup: no other task of the group(s) the dispatch belongs to is still open.
func (e *Env) endsGroup(st *State) bool {
	plans := map[string]*tasks.Plan{}
	mem := st.members()
	for _, m := range mem {
		if m.File == "" || m.Line == 0 || !exists(m.File) {
			return true
		}
		if plans[m.File] == nil {
			plans[m.File] = e.planFile(m.File)
		}
		var g *tasks.Group
		for _, x := range plans[m.File].Groups {
			for _, t := range x.Tasks {
				if t.Line == m.Line {
					g = x
				}
			}
		}
		if g == nil {
			return true
		}
		for _, t := range g.Tasks {
			if !t.Done && !slices.ContainsFunc(mem, func(y Member) bool { return y.File == m.File && y.Line == t.Line }) {
				return false
			}
		}
	}
	return true
}

func (e *Env) deferReason(st *State) string {
	if others := st.otherOpenLanes(); len(others) > 0 {
		return fmt.Sprintf("parallel wave: runs at the wave's last check (tasks %s are still open)", strings.Join(others, ", "))
	}
	lvl := e.checkLevel()
	if lvl == "task" || tasks.IsReview(st.Task.Label, st.Task.Title) {
		return ""
	}
	if lvl == "finish" {
		return "Check level: finish (runs once, at finish)"
	}
	if e.endsGroup(st) {
		return ""
	}
	return fmt.Sprintf("Check level: %s (runs when the last task of the group is checked)", lvl)
}

// ---------- fast path scope ----------

const scopeMaxLines = 150

func (e *Env) upgradeFile() string { return filepath.Join(e.R.Runs(e.O.Change), "upgrade.json") }

func (e *Env) readUpgrade() *quality.Upgrade {
	var u quality.Upgrade
	if runstate.ReadJSON(e.upgradeFile(), &u) {
		return &u
	}
	return nil
}

func textLines(f string, since time.Time) int {
	st, err := os.Stat(f)
	if err != nil || st.Size() > 512*1024 || st.ModTime().Before(since) {
		return 0
	}
	b, err := os.ReadFile(f)
	if err != nil || slices.Contains(b[:min(len(b), 8000)], 0) {
		return 0
	}
	return strings.Count(string(b), "\n") + 1
}

// scopeReasons: the code changed since the base commit outgrew a fast change.
func (e *Env) scopeReasons() []string {
	base := e.changeBase()
	now := e.changedFiles()
	if base == "" || now == nil {
		return nil
	}
	tr := e.paths()
	prod := func(f string) bool {
		return !tr.IsSpecPath(f) && !testpaths.IsTestPath(f) && exists(filepath.Join(e.code, f))
	}
	var files []string
	for _, f := range uniq(append(e.namesSince(base), now...)) {
		if prod(f) {
			files = append(files, f)
		}
	}
	var reasons, sens, ui []string
	for _, f := range files {
		if quality.IsSensitivePath(f) {
			sens = append(sens, f)
		}
		if visual.IsUIFile(f, e.Cfg.Visual) {
			ui = append(ui, f)
		}
	}
	if len(sens) > 0 {
		reasons = append(reasons, "edited a sensitive path: "+strings.Join(sens, ", "))
	}
	if len(ui) > 0 {
		reasons = append(reasons, "changed UI files: "+strings.Join(ui, ", "))
	}
	tracked := map[string]bool{}
	for _, f := range runstate.Files(e.code).Tracked {
		tracked[f] = true
	}
	lines := 0
	for _, l := range gitx.Lines(e.code, "diff", "--numstat", base, "--") {
		p := strings.Split(l, "\t")
		if len(p) == 3 && prod(p[2]) {
			var a, d int
			_, _ = fmt.Sscan(p[0], &a) // "-" for a binary file: counts 0
			_, _ = fmt.Sscan(p[1], &d)
			lines += a + d
		}
	}
	var since time.Time
	if st, err := os.Stat(filepath.Join(e.R.Runs(e.O.Change), "base")); err == nil {
		since = st.ModTime()
	}
	for _, f := range files {
		if !tracked[f] {
			lines += textLines(filepath.Join(e.code, f), since)
		}
	}
	if lines > scopeMaxLines {
		reasons = append(reasons, fmt.Sprintf("%d changed lines (a fast change allows %d)", lines, scopeMaxLines))
	}
	return reasons
}

// checkScope upgrades a fast-path change whose edits left its scope (upgrade.json); returns the new reasons.
func (e *Env) checkScope(changeDir string) []string {
	if e.readUpgrade() != nil {
		return nil
	}
	f := quality.SizeFacts(changeDir, nil)
	if !f.HasProposal || f.IsSlice || f.SpecOnly || quality.PlanPath(f).Path != "fast" {
		return nil
	}
	reasons := e.scopeReasons()
	if len(reasons) == 0 {
		return nil
	}
	_ = runstate.WriteJSON(e.upgradeFile(), quality.Upgrade{At: runstate.Now(), Reasons: reasons})
	return reasons
}

// ---------- per-task quality rules ----------

type outcome struct {
	checks   []any
	failures []string
	warnings []string
}

func (o *outcome) fail(s string)    { o.failures = append(o.failures, s) }
func (o *outcome) warn(s ...string) { o.warnings = append(o.warnings, s...) }
func (o *outcome) check(x *Obj)     { o.checks = append(o.checks, x) }
func (o *outcome) merge(p outcome) {
	o.checks = append(o.checks, p.checks...)
	o.failures = append(o.failures, p.failures...)
	o.warnings = append(o.warnings, p.warnings...)
}

func bullets(xs []string) string {
	var b strings.Builder
	for i, x := range xs {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("- " + x)
	}
	return b.String()
}

// sourceTextCheck applies the source-text rule to test files.
func (e *Env) sourceTextCheck(files []string) (bad, allowed []string) {
	for _, f := range files {
		fs, opt := quality.SourceTextFindings(filepath.Join(e.code, f), f)
		if len(fs) == 0 {
			continue
		}
		if opt != "" {
			allowed = append(allowed, fmt.Sprintf("%s: source-text-ok (%s)", f, opt))
			continue
		}
		for _, x := range fs {
			bad = append(bad, x.Text)
		}
	}
	return bad, allowed
}

// tokenLint is the design-token lint over changed UI files (through the visual helper); nil when there is nothing to check.
func (e *Env) tokenLint(changeDir string, files []string) *tokenResult {
	var ui []string
	for _, f := range files {
		if visual.IsUIFile(f, e.Cfg.Visual) && !testpaths.IsTestPath(f) && exists(filepath.Join(e.code, f)) {
			ui = append(ui, f)
		}
	}
	if len(ui) == 0 || !visual.Available(e.code) {
		return nil
	}
	var wrap struct {
		Tokens *tokenResult `json:"tokens"`
	}
	if err := visual.Call(e.Ctx, e.code, "design-scan", map[string]any{"code_root": e.code, "change_dir": changeDir, "root": e.R.Specs, "files": ui}, &wrap, nil); err != nil {
		e.say("WARNING: design token lint skipped: %v", err)
		return nil
	}
	return wrap.Tokens
}

type tokenResult struct {
	Files    int            `json:"files"`
	Errors   []string       `json:"errors"`
	Warnings []string       `json:"warnings"`
	Counts   map[string]any `json:"counts"`
}

func (o *outcome) addTokenLint(tl *tokenResult) {
	if tl == nil {
		return
	}
	x := O("check", "design_tokens", "ok", len(tl.Errors) == 0, "files", tl.Files)
	for k, v := range tl.Counts {
		x.Set(k, v)
	}
	o.check(x.Set("errors", len(tl.Errors)).Set("warnings", len(tl.Warnings)))
	if len(tl.Errors) > 0 {
		o.fail("UI code hard-codes values the project has tokens for:\n" + bullets(tl.Errors) + "\nBuild with the project's tokens and components (design-map.md; `wingman-spec design-system` lists them).")
	}
	for _, w := range tl.Warnings {
		o.warn("design tokens: " + w)
	}
}

// guardReport is the anchor guard over the diff against base; nil when it is off.
func (e *Env) guardReport(changeDir, base, scope string, taskFiles []string) (*anchors.GuardResult, string) {
	if trace.Mode(e.Cfg) == "off" {
		return nil, ""
	}
	lvl := trace.LevelsOf(e.Cfg).Guard
	if lvl == "off" || base == "" {
		return nil, ""
	}
	tr := e.tr()
	m := tr.ChangeMentions(changeDir)
	mine := map[string]bool{}
	many := map[string]bool{}
	for _, k := range e.Cfg.AnchorMany {
		many[k] = true
	}
	for _, d := range trace.Deltas(changeDir) {
		for _, r := range d.Reqs {
			if r.Op == "ADDED" || r.Op == "MODIFIED" {
				mine[d.Cap+"/"+r.Slug] = true
			}
			if anchorsManyRE.MatchString(r.Block) {
				many[d.Cap+"/"+r.Slug] = true
			}
		}
	}
	o := anchors.GuardOpts{CodeRoot: e.code, Base: base, Listed: m.Listed, Reviewed: m.Reviewed, RemovedKeys: m.Removed, ManyKeys: many, Markers: tr.ScanAnchors(nil), IsTest: testpaths.IsTestPath, Skip: tr.IsSpecPath, MineKeys: map[string]bool{}}
	if scope == "change" {
		o.ModifiedKeys, o.MineKeys = m.Modified, mine
	} else {
		o.TaskFiles = taskFiles
	}
	r := anchors.Guard(o)
	return &r, lvl
}

var anchorsManyRE = regexp.MustCompile(`(?mi)^\s*Anchors:\s*many\b`)

func (o *outcome) addGuard(r *anchors.GuardResult, lvl, mode string) {
	if r == nil {
		return
	}
	hard := lvl == "error" && mode == "on"
	var kinds []string
	for _, f := range r.Findings {
		if !slices.Contains(kinds, f.Kind) {
			kinds = append(kinds, f.Kind)
		}
	}
	o.check(O("check", "anchor_guard", "ok", !hard || len(r.Findings) == 0, "findings", len(r.Findings), "kinds", list(kinds)))
	if hard && len(r.Findings) > 0 {
		var ls []string
		for _, f := range r.Findings {
			ls = append(ls, f.Kind+": "+f.Text)
		}
		o.fail("anchor guard (anchor_guard: error):\n" + bullets(ls))
		return
	}
	for _, f := range r.Findings {
		o.warn(fmt.Sprintf("anchor guard: %s: %s", f.Kind, f.Text))
	}
}

func (e *Env) existing(files []string) []string {
	out := []string{}
	for _, f := range files {
		if exists(filepath.Join(e.code, f)) {
			out = append(out, f)
		}
	}
	return out
}

// qualityChecks: source-text tests among the changed files, design tokens, accessible names, anchors, and trace tags for
// the scenarios the Spec: lines name one by one.
func (e *Env) qualityChecks(changeDir string, st *State, scens []*quality.Scenario) outcome {
	var o outcome
	changed := e.changedFiles()
	var tests []string
	for _, f := range e.existing(changed) {
		if testpaths.IsTestFile(f) {
			tests = append(tests, f)
		}
	}
	mode := trace.Mode(e.Cfg)
	if mode != "off" {
		_ = e.index()
	}
	if scens == nil {
		scens = e.scenariosOf(changeDir)
	}
	var (
		bad, allowed []string
		tl           *tokenResult
		aria         []string
		markers      []trace.MarkerProblem
		place        []string
		placeLvl     string
		gr           *anchors.GuardResult
		glvl         string
		tagMap       map[string][]string
		wg           sync.WaitGroup
	)
	wg.Go(func() { bad, allowed = e.sourceTextCheck(tests) })
	wg.Go(func() { tl = e.tokenLint(changeDir, changed) })
	wg.Go(func() {
		for _, f := range changed {
			if uiExtRE.MatchString(f) && !testpaths.IsTestPath(f) {
				for _, a := range quality.AriaLabelFindings(filepath.Join(e.code, f), f) {
					aria = append(aria, a.Text)
				}
			}
		}
	})
	if mode != "off" {
		tr := e.tr()
		ex := e.existing(changed)
		wg.Go(func() {
			markers = runstate.Timed("scan: @spec markers in changed files", func() []trace.MarkerProblem { return tr.MarkerProblems(changeDir, ex) })
		})
		wg.Go(func() {
			if lvl := trace.LevelsOf(e.Cfg).Placement; lvl != "off" {
				placeLvl = lvl
				for _, x := range tr.PlacementProblems(nil, ex) {
					place = append(place, fmt.Sprintf("%s:%d: %s: %s", x.File, x.Line, x.Kind, x.Text))
				}
			}
		})
		var det []string
		for _, m := range st.members() {
			det = append(det, m.Details...)
		}
		wg.Go(func() { gr, glvl = e.guardReport(changeDir, "HEAD", "task", filesOf(det)) })
	}
	needTrace := slices.ContainsFunc(st.members(), func(m Member) bool { return specLineOf(m) != "" })
	if needTrace {
		wg.Go(func() { tagMap = e.traceTags(e.testFiles()) })
	}
	wg.Wait()
	o.check(O("check", "source_text", "ok", len(bad) == 0, "files", len(tests), "findings", len(bad), "allowed", len(allowed)))
	if len(bad) > 0 {
		o.fail("tests read source files as text:\n" + bullets(bad) + "\n" + quality.SourceTextFix)
	}
	for _, a := range allowed {
		o.warn("allowed source-text test: " + a)
	}
	o.addTokenLint(tl)
	for _, a := range aria {
		o.warn("accessible name: " + a)
	}
	if mode != "off" {
		o.check(O("check", "anchors", "ok", len(markers) == 0 || mode == "warn", "unresolved", len(markers)))
		var msg []string
		for _, m := range markers {
			s := fmt.Sprintf("%s:%d: `@spec %s` does not resolve to a requirement", m.File, m.Line, m.Key)
			if m.Hint != "" {
				s += fmt.Sprintf(" (did you mean %s?)", m.Hint)
			}
			msg = append(msg, s)
		}
		if len(markers) > 0 && mode == "on" {
			o.fail(fmt.Sprintf("code anchors that do not resolve (the slug is the requirement name lower-cased with dashes; `wingman-spec anchors %s` lists the valid ones):\n%s", e.O.Change, bullets(msg)))
		} else {
			o.warn(msg...)
		}
		if placeLvl != "" {
			if len(place) > 0 && placeLvl == "error" && mode == "on" {
				o.check(O("check", "marker_placement", "ok", false, "findings", len(place)))
				o.fail("marker placement (anchor_placement: error; `wingman-spec help anchors` lists the rules):\n" + bullets(place))
			} else {
				for _, x := range place {
					o.warn("marker placement: " + x)
				}
			}
		}
		o.addGuard(gr, glvl, mode)
	}
	if needTrace {
		res := quality.Trace(scens, tagMap, !e.Cfg.Visual.Off)
		refs := specRefsOf(st, scens)
		missing := map[string]bool{}
		for _, s := range res.Missing {
			missing[s.ID] = true
		}
		var miss, soft []string
		for _, s := range refs.Explicit {
			if missing[s.ID] {
				miss = append(miss, s.ID)
			}
		}
		for _, s := range refs.Implicit {
			if missing[s.ID] {
				soft = append(soft, s.ID)
			}
		}
		o.check(O("check", "trace", "ok", len(miss) == 0, "named", len(refs.Explicit), "untested", list(miss), "requirement_level_untested", len(soft)))
		if len(miss) > 0 {
			o.fail(fmt.Sprintf("no test is tagged for %d scenario(s) this task's Spec: line names: %s. %s", len(miss), bracket(miss), tagHelp))
		}
		if len(soft) > 0 {
			o.warn(fmt.Sprintf("Spec: names requirement(s) without picking scenarios; untested so far: %s (finish fails if they stay untested)", bracket(soft)))
		}
	}
	return o
}

func bracket(ids []string) string {
	var out []string
	for _, x := range ids {
		out = append(out, "["+x+"]")
	}
	return strings.Join(out, ", ")
}

// ---------- check ----------

type step struct{ name, cmd, via string }

// Check verifies the dispatch `next` handed out.
func (e *Env) Check() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	if err := e.Begin(); err != nil {
		return err
	}
	run := e.currentRun(false)
	if run == "" || !exists(filepath.Join(run, "state.json")) {
		return die(Usage, "no task in progress: run `next` first")
	}
	st, err := readState(run)
	if err != nil {
		return die(Usage, "cannot read the run state: %v", err)
	}
	if st, err = e.pickLane(st, false); err != nil {
		return err
	}
	if st.Task == nil {
		return die(Usage, "no task in progress: the last task was already checked and passed; run `next %s` to start the next task before `check` (if you already ticked its box in tasks.md, untick it first: `next` picks the first unticked task)", e.O.Change)
	}
	if st.Exhausted {
		e.emit(O("result", "exhausted", "task", st.Task.Label))
		return quit(Exhausted)
	}
	if st.Review != nil {
		return die(Usage, "task %s is waiting for its visual review: dispatch spec-visual-reviewer with %s, then run `review %s --reply <file>`", st.Task.Label, st.Review.Prompt, e.O.Change)
	}
	var o outcome
	if !st.AttemptOpen {
		if st.Attempts == 0 {
			return die(Usage, "task %s was not handed out: run `next %s` first", st.Task.Label, e.O.Change)
		}
		st.AttemptOpen = true
		writeState(run, st)
		o.warn(fmt.Sprintf("attempt %d of %d of task %s opened by this check (the previous check failed; no `next` needed)", st.Attempts+1, e.O.MaxAttempts, st.Task.Label))
		logMetric(run, O("event", "reopen", "task", st.Task.Label, "attempt", st.Attempts+1))
	}
	t0 := time.Now()
	blocked := exists(filepath.Join(changeDir, "BLOCKED.md"))
	if blocked && st.lane != nil && e.O.Reported != "blocked" {
		blocked = false // another task of the wave is blocked; this one is judged on its own work
		o.warn("BLOCKED.md exists (another task of this wave is blocked); this task is checked on its own work")
	}
	tinfo := e.testCmd()
	if p := testCmdProblem(tinfo); p != "" {
		return die(Usage, "REFUSED: %s", p)
	}
	// 1. tasks.md: exactly the target tick, nothing else.
	ts, _, err := e.loadTasks(changeDir)
	if err != nil {
		return err
	}
	files := []string{tasksFile(changeDir)}
	diff := diffTasks(st, files)
	pre := map[string]bool{}
	for _, p := range st.PreTasks {
		pre[p.Description] = p.Done
	}
	var newly, deleted []string
	now := map[string]bool{}
	for _, t := range ts {
		now[t.Desc] = true
		if t.Done && !pre[t.Desc] {
			newly = append(newly, t.Desc)
		}
	}
	for _, p := range st.PreTasks {
		if !now[p.Description] {
			deleted = append(deleted, p.Description)
		}
	}
	n := len(st.members())
	if len(deleted) > 0 {
		o.fail("tasks deleted or reworded: " + strings.Join(deleted, "; "))
	}
	if len(newly) > n {
		what := "one task"
		if n > 1 {
			what = fmt.Sprintf("%d tasks", n)
		}
		o.fail(fmt.Sprintf("more than %s ticked: %s", what, strings.Join(newly, "; ")))
	}
	for _, d := range diff {
		o.fail("tasks.md edited outside the target checkbox: " + d)
	}
	o.check(O("check", "tasks", "ok", len(o.failures) == 0, "newly_ticked", len(newly), "deleted", len(deleted)))
	if st.lane != nil {
		fails, warns := e.ownership(st)
		for _, f := range fails {
			o.fail(f)
		}
		o.warn(warns...)
		o.check(O("check", "ownership", "ok", len(fails) == 0, "files", len(e.waveTouched(st.parent.Wave))))
	}
	// 2. the subagent's own report and BLOCKED.md
	if blocked {
		o.fail("BLOCKED.md exists")
	}
	switch e.O.Reported {
	case "done":
	case "none":
		o.fail("the subagent's reply ended without a STATUS line")
	default:
		o.fail("subagent reported STATUS: " + e.O.Reported)
	}
	var vis *Obj
	review := ""
	var rubric []string
	if len(o.failures) == 0 {
		vis, review, rubric = e.runChecks(changeDir, run, st, tinfo, &o)
	}
	if len(o.failures) == 0 {
		if up := e.checkScope(changeDir); len(up) > 0 {
			extra := ""
			if quality.PlanPath(quality.SizeFacts(changeDir, e.readUpgrade())).Review {
				extra = ", and add the final review task"
			}
			o.warn(fmt.Sprintf("left the fast path: %s. Write design.md, adrs/none.md (or ADRs) and app-map.md%s before `next` continues", strings.Join(up, "; "), extra))
		}
	}
	for _, w := range o.warnings {
		e.say("WARNING: %s", w)
	}
	st.AttemptOpen = false
	secs := time.Since(t0).Seconds()
	checks := list(o.checks)
	warnings := list(o.warnings)
	if len(o.failures) == 0 && review != "" {
		dir, _ := vis.Get("dir").(string)
		st.Review = &ReviewState{Prompt: review, Dir: dir, Checks: checks, Seconds: secs, Started: runstate.Now(), Rubric: rubric}
		writeState(run, st)
		logCheck(run, O("event", "check", "task", st.Task.Label, "attempt", st.Attempts+1, "ok", true, "review_pending", true, "seconds", secs, "checks", checks))
		e.emit(O("result", "review-pending", "task", st.Task.Label, "review_prompt", review, "area_images", filepath.Join(dir, "areas"),
			"next", fmt.Sprintf("dispatch an independent spec-visual-reviewer subagent with the review prompt, save its reply, then: review %s --reply <file>. Never review your own screenshots; if no subagent can run, record it as skipped: review %s --reviewer none", e.O.Change, e.O.Change),
			"checks", checks, "visual", vis, "warnings", warnings))
		return quit(Review)
	}
	if len(o.failures) == 0 {
		logCheck(run, O("event", "check", "task", st.Task.Label, "attempt", st.Attempts+1, "ok", true, "seconds", secs, "checks", checks))
		return e.pass(run, st, checks, vis, warnings, changeDir)
	}
	return e.reject(run, st, o.failures, rejectInfo{blocked: blocked, seconds: secs, checks: checks, visual: vis, warnings: warnings})
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// validateChange validates the change strictly (warnings count); the lines are the issues.
func validateChange(r *layout.Root, name string) ([]string, error) {
	rep, err := change.Validate(r, name)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, i := range rep.Issues {
		out = append(out, i.String())
	}
	if !rep.Valid && len(out) == 0 {
		out = append(out, "the change is not valid")
	}
	return out, nil
}

// pass ticks the dispatch, records it and prints `passed`.
func (e *Env) pass(run string, st *State, checks []any, vis *Obj, warnings []string, changeDir string) error {
	e.tickTask(st)
	fp := runstate.Fingerprinted(e.code, true)
	for _, m := range st.members() {
		e.recordPass(run, m, fp)
	}
	done := st.Task.Label
	e.dropNotes(done)
	st.Task, st.Attempts, st.LastFailure, st.Review = nil, 0, nil, nil
	writeState(run, st)
	_, p, _ := e.loadTasks(changeDir)
	x := O("result", "passed", "task", done, "checks", checks)
	if e.O.Cmd == "check" {
		x.Set("visual", nilObj(vis)).Set("warnings", list(warnings)).Set("progress", p)
	}
	if st.lane != nil {
		x.Set("wave", waveObj(st))
	}
	e.emit(x)
	return nil
}

func nilObj(o *Obj) any {
	if o == nil {
		return nil
	}
	return o
}

// runChecks runs Done when, the project commands, the visual check and the quality rules (stops at the first failure).
