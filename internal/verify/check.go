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
func tickTask(st *State) {
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
		}
	}
}

func restore(st *State) {
	for _, s := range st.Snapshots {
		if b, err := os.ReadFile(s.Snap); err == nil {
			_ = os.WriteFile(s.File, b, 0o644)
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
		since = gitx.Lines(e.code, "diff", "--name-only", base, "--")
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
func (e *Env) targetedTests(changeDir string, st *State, testCmd string) targeted {
	tpl, source, why := e.targetedTemplate(testCmd)
	if tpl == "" {
		return targeted{why: why}
	}
	all := quality.ListTestFiles(e.code)
	changed := e.changedTestFiles(e.changeBase())
	if st.lane != nil { // in a wave: only this task's tests; the other tasks' tests may be half-written
		mine := filesOf(st.Task.Details)
		changed = slices.DeleteFunc(changed, func(f string) bool { return !ownsAny(mine, f) && len(testpaths.TestsFor(mine, []string{f})) == 0 })
	}
	refs := specRefsOf(st, quality.SpecScenarios(filepath.Join(changeDir, "specs")))
	idset := map[string]bool{}
	for _, s := range append(refs.Explicit, refs.Implicit...) {
		idset[s.ID] = true
	}
	var tagged []string
	if len(idset) > 0 {
		tags := quality.TraceTags(all, e.code)
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
	var qf, dirs []string
	for _, f := range files {
		qf = append(qf, shq(f))
		dirs = append(dirs, shq("./"+filepath.ToSlash(filepath.Dir(f))))
	}
	cmd := strings.Replace(strings.Replace(tpl, "{files}", strings.Join(qf, " "), 1), "{dirs}", strings.Join(uniq(dirs), " "), 1)
	return targeted{cmd: cmd, tpl: tpl, source: source, files: files, counts: counts}
}

// ---------- check level ----------

// endsGroup: no other task of the group(s) the dispatch belongs to is still open.
func endsGroup(st *State) bool {
	plans := map[string]*tasks.Plan{}
	mem := st.members()
	for _, m := range mem {
		if m.File == "" || m.Line == 0 || !exists(m.File) {
			return true
		}
		if plans[m.File] == nil {
			plans[m.File] = tasks.Parse(readText(m.File))
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
	if endsGroup(st) {
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
	tr := e.tr()
	prod := func(f string) bool {
		return !tr.IsSpecPath(f) && !testpaths.IsTestPath(f) && exists(filepath.Join(e.code, f))
	}
	var files []string
	for _, f := range uniq(append(gitx.Lines(e.code, "diff", "--name-only", base, "--"), now...)) {
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
	for _, f := range gitx.Lines(e.code, "ls-files") {
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
	var r *tokenResult
	if err := visual.Call(e.Ctx, e.code, "token-lint", map[string]any{"code_root": e.code, "change_dir": changeDir, "files": ui}, &r, nil); err != nil {
		e.say("WARNING: design token lint skipped: %v", err)
		return nil
	}
	return r
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
func (e *Env) qualityChecks(changeDir string, st *State) outcome {
	var o outcome
	changed := e.changedFiles()
	var tests []string
	for _, f := range e.existing(changed) {
		if testpaths.IsTestFile(f) {
			tests = append(tests, f)
		}
	}
	bad, allowed := e.sourceTextCheck(tests)
	o.check(O("check", "source_text", "ok", len(bad) == 0, "files", len(tests), "findings", len(bad), "allowed", len(allowed)))
	if len(bad) > 0 {
		o.fail("tests read source files as text:\n" + bullets(bad) + "\n" + quality.SourceTextFix)
	}
	for _, a := range allowed {
		o.warn("allowed source-text test: " + a)
	}
	o.addTokenLint(e.tokenLint(changeDir, changed))
	for _, f := range changed {
		if uiExtRE.MatchString(f) && !testpaths.IsTestPath(f) {
			for _, a := range quality.AriaLabelFindings(filepath.Join(e.code, f), f) {
				o.warn("accessible name: " + a.Text)
			}
		}
	}
	mode := trace.Mode(e.Cfg)
	if mode != "off" {
		tr := e.tr()
		ex := e.existing(changed)
		bad := runstate.Timed("scan: @spec markers in changed files", func() []trace.MarkerProblem { return tr.MarkerProblems(changeDir, ex) })
		o.check(O("check", "anchors", "ok", len(bad) == 0 || mode == "warn", "unresolved", len(bad)))
		var msg []string
		for _, m := range bad {
			s := fmt.Sprintf("%s:%d: `@spec %s` does not resolve to a requirement", m.File, m.Line, m.Key)
			if m.Hint != "" {
				s += fmt.Sprintf(" (did you mean %s?)", m.Hint)
			}
			msg = append(msg, s)
		}
		if len(bad) > 0 && mode == "on" {
			o.fail(fmt.Sprintf("code anchors that do not resolve (the slug is the requirement name lower-cased with dashes; `wingman-spec anchors %s` lists the valid ones):\n%s", e.O.Change, bullets(msg)))
		} else {
			o.warn(msg...)
		}
		if lvl := trace.LevelsOf(e.Cfg).Placement; lvl != "off" {
			var pl []string
			for _, x := range tr.PlacementProblems(nil, ex) {
				pl = append(pl, fmt.Sprintf("%s:%d: %s: %s", x.File, x.Line, x.Kind, x.Text))
			}
			if len(pl) > 0 && lvl == "error" && mode == "on" {
				o.check(O("check", "marker_placement", "ok", false, "findings", len(pl)))
				o.fail("marker placement (anchor_placement: error; `wingman-spec help anchors` lists the rules):\n" + bullets(pl))
			} else {
				for _, x := range pl {
					o.warn("marker placement: " + x)
				}
			}
		}
		var det []string
		for _, m := range st.members() {
			det = append(det, m.Details...)
		}
		r, lvl := e.guardReport(changeDir, "HEAD", "task", filesOf(det))
		o.addGuard(r, lvl, mode)
	}
	if slices.ContainsFunc(st.members(), func(m Member) bool { return specLineOf(m) != "" }) {
		scens := quality.SpecScenarios(filepath.Join(changeDir, "specs"))
		res := quality.Trace(scens, quality.TraceTags(quality.ListTestFiles(e.code), e.code), !e.Cfg.Visual.Off)
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
	ts, _, err := loadTasks(changeDir)
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
	if e.O.Reported != "done" {
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
		logMetric(run, O("event", "check", "task", st.Task.Label, "attempt", st.Attempts+1, "ok", true, "review_pending", true, "seconds", secs, "checks", checks))
		e.emit(O("result", "review-pending", "task", st.Task.Label, "review_prompt", review, "area_images", filepath.Join(dir, "areas"),
			"next", fmt.Sprintf("dispatch an independent spec-visual-reviewer subagent with the review prompt, save its reply, then: review %s --reply <file>. Never review your own screenshots; if no subagent can run, record it as skipped: review %s --reviewer none", e.O.Change, e.O.Change),
			"checks", checks, "visual", vis, "warnings", warnings))
		return quit(Review)
	}
	if len(o.failures) == 0 {
		logMetric(run, O("event", "check", "task", st.Task.Label, "attempt", st.Attempts+1, "ok", true, "seconds", secs, "checks", checks))
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
	tickTask(st)
	for _, m := range st.members() {
		e.recordPass(run, m)
	}
	done := st.Task.Label
	st.Task, st.Attempts, st.LastFailure, st.Review = nil, 0, nil, nil
	writeState(run, st)
	_, p, _ := loadTasks(changeDir)
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
		tg := e.targetedTests(changeDir, st, tinfo.cmd())
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
	q := e.qualityChecks(changeDir, st)
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
			e.memo = nil
		}
		ranCmds[norm(c.cmd)] = c.name
		x := O("check", c.name, "ok", r.RC == 0, "rc", r.RC, "timed_out", r.TimedOut, "seconds", r.Seconds)
		if r.Cached {
			x.Set("cached", true)
		}
		o.check(x)
		if r.RC != 0 {
			text := failText(c.name, r) + "\n" + r.Tail
			if st.lane != nil && c.name != "done_when" && !e.blameWave(st, text, o) {
				continue // the failure names only files of tasks that passed earlier in the wave: they are reopened
			}
			o.fail(text)
			return vis, "", nil
		}
	}
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
	exhausted := st.Attempts >= e.O.MaxAttempts
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
	logMetric(run, O("event", ev, "task", st.Task.Label, "attempt", st.Attempts, "ok", false, "blocked", x.blocked, "exhausted", exhausted, "seconds", x.seconds, "checks", x.checks, "failures", firsts).Merge(x.metric))
	result, code := "failed", Fail
	switch {
	case x.blocked:
		result, code = "blocked", Blocked
	case exhausted:
		result, code = "exhausted", Exhausted
	}
	out := O("result", result, "task", st.Task.Label, "attempt", st.Attempts, "max_attempts", e.O.MaxAttempts, "failures", failures, "reverted", true, "checks", x.checks, "visual", If(x.visual != nil, x.visual), "warnings", If(x.warnings != nil, x.warnings))
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
