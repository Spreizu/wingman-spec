package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// Review proof: a review task that changes code must show each fix with a test that fails on the code as the task
// was handed out and passes now. progress.md holds one `Review fix: <slug> - <finding>` line per fix, and the test
// carries `[review:<slug>]` or `review_<slug>` in its name (testpaths.OneTest). `untestable: <reason>` on the line instead skips the test; it is recorded.

var (
	reviewFixRE  = regexp.MustCompile(`(?m)^\s*(?:[-*]\s+)?Review fix:\s*([a-z0-9][a-z0-9-]*)\b(.*)$`)
	untestableRE = regexp.MustCompile(`(?i)\buntestable:\s*(.*\S)`)
)

type reviewFix struct{ slug, untestable string }

func reviewFixes(progress string) []reviewFix {
	var out []reviewFix
	for _, m := range reviewFixRE.FindAllStringSubmatch(progress, -1) {
		f := reviewFix{slug: m[1]}
		if u := untestableRE.FindStringSubmatch(m[2]); u != nil {
			f.untestable = u[1]
		}
		out = append(out, f)
	}
	return out
}

// codeChanges are the files other than tests, Markdown and Wingman Spec's own that differ between two commits.
func (e *Env) codeChanges(from, to string) []string {
	var out []string
	for _, f := range gitx.Lines(e.code, "diff", "--name-only", "--relative", from, to, "--") {
		if testpaths.IsTestFile(f) || strings.HasSuffix(f, ".md") || strings.HasPrefix(f, ".wingman-spec/") {
			continue
		}
		out = append(out, f)
	}
	return out
}

// reviewProof runs after a review task's other checks passed.
func (e *Env) reviewProof(changeDir string, st *State, tinfo CmdInfo, o *outcome) {
	if !tasks.IsReview(st.Task.Label, st.Task.Title) || st.Task.PreTree == "" {
		return
	}
	now := runstate.ReviewRange(e.code, "")
	if now == nil {
		return
	}
	code := e.codeChanges(st.Task.PreTree, now.Head)
	fixes := reviewFixes(readText(filepath.Join(changeDir, "progress.md")))
	x := O("check", "review_proof", "ok", true, "code_files", len(code))
	defer o.check(x)
	if len(code) == 0 {
		x.Set("skipped", "the review changed no code")
		return
	}
	failf := func(f string, a ...any) { x.Set("ok", false); o.fail("review proof: " + fmt.Sprintf(f, a...)) }
	if len(fixes) == 0 {
		failf("the review changed code (%s) but progress.md has no `Review fix: <slug> - <finding>` line. Record each Critical or Important fix with `wingman-spec progress %s --task %s --review-fix <slug> --note \"<finding>\"`; its test is named with `[review:<slug>]` or `review_<slug>` and fails without the fix, or add `--untestable \"<reason>\"`", strings.Join(code, ", "), e.O.Change, st.Task.Label)
		return
	}
	var proven, untestable, tests []string
	bySlug := map[string][]string{}
	all := e.testFiles()
	bodies := map[string]string{}
	for _, t := range all {
		bodies[t] = e.testBody(t)
	}
	for _, f := range fixes {
		if f.untestable != "" {
			untestable = append(untestable, f.slug+": "+f.untestable)
			o.warn(fmt.Sprintf("review fix %s has no test (untestable: %s)", f.slug, f.untestable))
			continue
		}
		var by []string
		for _, t := range all {
			if testpaths.Tagged(bodies[t], f.slug) {
				by = append(by, t)
			}
		}
		if len(by) == 0 {
			failf("no test is tagged `[review:%s]` or named `review_%s`: add one that fails without the fix, or record the fix again with `--untestable \"<reason>\"`", f.slug, strings.ReplaceAll(f.slug, "-", "_"))
			return
		}
		proven = append(proven, f.slug)
		bySlug[f.slug] = by
		tests = append(tests, by...)
	}
	x.Set("fixes", len(fixes)).Set("untestable", untestable)
	defer func() {
		ok, _ := x.Get("ok").(bool)
		e.tl(timeline.Event{Event: "review-proof", Task: st.Task.Label, OK: new(ok), Summary: fmt.Sprintf("%d review fix(es) with a fail-before/pass-after test, %d untestable", len(proven), len(untestable)),
			Details: map[string]any{"proven": proven, "untestable": untestable, "mode": x.Get("mode")}})
	}()
	if len(tests) == 0 {
		return
	}
	tests = uniq(tests)
	x.Set("tests", tests)
	one, why := e.oneTest(tinfo)
	if _, m := one.Command("x", tests); m == "" {
		x.Set("skipped", why)
		o.warn("review proof not run (" + why + "): the tagged tests were not run on the code before the fix")
		return
	}
	before, err := e.preCopy(st.Task.PreTree, tests)
	if err != "" {
		x.Set("skipped", err)
		o.warn("review proof not run: " + err)
		return
	}
	defer func() { _ = os.RemoveAll(before) }()
	// each fix on its own, so one failing test cannot cover for another that passes without its fix; the same
	// command runs after, so a name filter that selects nothing fails there
	rcs, modes := map[string]int{}, map[string]string{}
	x.Set("before", rcs).Set("mode", modes)
	ran := map[string]bool{}
	for _, slug := range proven {
		cmd, mode := one.Command(slug, bySlug[slug])
		modes[slug] = mode
		rb := e.runCmd(cmd, before, e.timeoutFor("tests"), "review proof (before)")
		rcs[slug] = rb.RC
		if rb.RC == 0 {
			failf("the test of fix %s passes on the code as it was before the review (%s, %s), so it does not show the fix. Make it fail without the fix", slug, mode, cmd)
			return
		}
		if ran[cmd] {
			continue
		}
		ran[cmd] = true
		if ra := e.runCmd(cmd, e.code, e.timeoutFor("tests"), "review proof (after)"); ra.RC != 0 {
			failf("the test of fix %s fails on the fixed code (%s, %s):\n%s\n%s", slug, mode, cmd, failText("tests", ra), ra.Tail)
			return
		}
	}
	x.Set("proven", proven)
}

// oneTest is how this project runs the tests of one fix (see testpaths.OneTest), and why there is no way when none.
func (e *Env) oneTest(tinfo CmdInfo) (testpaths.OneTest, string) {
	var one testpaths.OneTest
	why := "commands.test: none"
	if c := e.cmdInfo("test_one", "test_one", "WINGMAN_SPEC_TEST_ONE_CMD"); c.Cmd != nil {
		one.Override = *c.Cmd
	}
	if tinfo.Cmd != nil {
		one.Test = tinfo.cmd()
		one.PerFile, _, why = e.targetedTemplate(one.Test)
	}
	var p struct{ Scripts map[string]string }
	runstate.ReadJSON(filepath.Join(e.code, "package.json"), &p)
	one.Script = p.Scripts["test"]
	one.Has = func(g string) bool { m, _ := filepath.Glob(filepath.Join(e.code, g)); return len(m) > 0 }
	return one, why
}

// preCopy is a temporary copy of the code root as tree had it, with today's versions of the given tests and the
// project's node_modules linked in. The caller removes it.
func (e *Env) preCopy(tree string, tests []string) (string, string) {
	d, err := os.MkdirTemp("", "wingman-review-proof-")
	if err != nil {
		return "", err.Error()
	}
	if r := e.runCmd(fmt.Sprintf("git archive --format=tar %s | tar -x -C %s", shq(tree+":./"), shq(d)), e.code, 120, ""); r.RC != 0 {
		_ = os.RemoveAll(d)
		return "", "could not unpack the code before the review: " + firstLine(r.Tail)
	}
	for _, t := range tests {
		b, err := os.ReadFile(filepath.Join(e.code, t))
		if err != nil {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(filepath.Join(d, t)), 0o755)
		_ = os.WriteFile(filepath.Join(d, t), b, 0o644)
	}
	if nm := filepath.Join(e.code, "node_modules"); exists(nm) && !exists(filepath.Join(d, "node_modules")) {
		_ = os.Symlink(nm, filepath.Join(d, "node_modules"))
	}
	return d, ""
}
