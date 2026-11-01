package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// Review proof: a review task that changes code must show each fix with a test that fails on the code as the task
// was handed out and passes now. progress.md holds one `Review fix: <slug> - <finding>` line per fix, and the test
// carries `[review:<slug>]` in its name. `untestable: <reason>` on the line instead skips the test; it is recorded.

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
		failf("the review changed code (%s) but progress.md has no `Review fix: <slug> - <finding>` line. Each Critical or Important fix needs a test tagged `[review:<slug>]` that fails without the fix, or `untestable: <reason>` on its line", strings.Join(code, ", "))
		return
	}
	var proven, untestable, tests []string
	bySlug := map[string][]string{}
	all := quality.ListTestFiles(e.code)
	for _, f := range fixes {
		if f.untestable != "" {
			untestable = append(untestable, f.slug+": "+f.untestable)
			o.warn(fmt.Sprintf("review fix %s has no test (untestable: %s)", f.slug, f.untestable))
			continue
		}
		var by []string
		for _, t := range all {
			if strings.Contains(readText(filepath.Join(e.code, t)), "[review:"+f.slug+"]") {
				by = append(by, t)
			}
		}
		if len(by) == 0 {
			failf("no test is tagged `[review:%s]`: add one that fails without the fix, or write `untestable: <reason>` on its `Review fix:` line", f.slug)
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
			Details: map[string]any{"proven": proven, "untestable": untestable}})
	}()
	if len(tests) == 0 {
		return
	}
	tests = uniq(tests)
	x.Set("tests", tests)
	var tpl, why string
	if tinfo.Cmd != nil {
		tpl, _, why = e.targetedTemplate(tinfo.cmd())
	} else {
		why = "commands.test: none"
	}
	if tpl == "" {
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
	// before: each fix on its own, so one failing test cannot cover for another that passes without its fix
	runner := e.nodeRunner(tpl, tinfo.cmd())
	rcs := map[string]int{}
	x.Set("before", rcs)
	for _, slug := range proven {
		t := tpl
		if f := nameFilter(runner, slug); f != "" {
			t = strings.Replace(tpl, "{files}", f+" {files}", 1)
		} else {
			x.Set("test_level", "file") // the runner has no name filter we know: the tagged files run whole
		}
		cmd := withFiles(t, bySlug[slug])
		rb := e.runCmd(cmd, before, e.timeoutFor("tests"), "review proof (before)")
		rcs[slug] = rb.RC
		if rb.RC == 0 {
			failf("the test tagged `[review:%s]` passes on the code as it was before the review (%s), so it does not show the fix. Make it fail without the fix", slug, cmd)
			return
		}
	}
	if ra := e.runCmd(withFiles(tpl, tests), e.code, e.timeoutFor("tests"), "review proof (after)"); ra.RC != 0 {
		failf("the tests tagged for the review fixes fail on the fixed code:\n%s\n%s", failText("tests", ra), ra.Tail)
		return
	}
	x.Set("proven", proven)
}

// nodeRunner names the test runner when the per-file command is node:test, vitest or jest ("" otherwise).
func (e *Env) nodeRunner(tpl, testCmd string) string {
	var p struct{ Scripts map[string]string }
	runstate.ReadJSON(filepath.Join(e.code, "package.json"), &p)
	all := tpl + " " + testCmd + " " + p.Scripts["test"]
	switch {
	case strings.Contains(all, "vitest"):
		return "vitest"
	case strings.Contains(all, "jest"):
		return "jest"
	case strings.Contains(all, "node --test"):
		return "node"
	}
	return ""
}

// nameFilter selects only the tests whose name carries [review:<slug>].
func nameFilter(runner, slug string) string {
	pat := shq(`\[review:` + slug + `\]`)
	switch runner {
	case "node":
		return "--test-name-pattern=" + pat
	case "vitest", "jest":
		return "-t " + pat
	}
	return ""
}

func withFiles(tpl string, files []string) string {
	var qf, dirs []string
	for _, f := range files {
		qf = append(qf, shq(f))
		dirs = append(dirs, shq("./"+filepath.ToSlash(filepath.Dir(f))))
	}
	return strings.Replace(strings.Replace(tpl, "{files}", strings.Join(qf, " "), 1), "{dirs}", strings.Join(uniq(dirs), " "), 1)
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
