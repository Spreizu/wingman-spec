package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/checkparse"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// checksDir is where command logs go: runs/<change>/checks, or runs/checks without a change.
func (e *Env) checksDir() string {
	d := filepath.Join(e.R.Runs(""), "checks")
	if e.O.Change != "" {
		d = filepath.Join(e.runsDir(), "checks")
	} else if !exists(filepath.Join(e.R.Runs(""), ".gitignore")) {
		_ = os.MkdirAll(e.R.Runs(""), 0o755)
		_ = os.WriteFile(filepath.Join(e.R.Runs(""), ".gitignore"), []byte("*\n"), 0o644)
	}
	_ = os.MkdirAll(d, 0o755)
	return d
}

// writeLog writes a command's whole output to <dir>/<name>.log and returns the path relative to the code root.
func (e *Env) writeLog(dir, name string, r Result) string {
	f := filepath.Join(dir, strings.ReplaceAll(name, "/", "-")+".log")
	out := r.Full
	if out == "" {
		out = r.Tail
	}
	status := fmt.Sprintf("exit %d", r.RC)
	if r.TimedOut {
		status = fmt.Sprintf("timed out after %ds", r.Limit)
	}
	if os.WriteFile(f, fmt.Appendf(nil, "$ %s\n%s\n[%s, %.1fs, %s]\n", r.Cmd, out, status, r.Seconds, time.Now().Format(time.RFC3339)), 0o644) != nil {
		return ""
	}
	if rel, err := filepath.Rel(e.code, f); err == nil && !strings.HasPrefix(rel, "..") {
		return rel
	}
	return f
}

// parsed reads a command's output (and the configured JUnit report when the run wrote it).
func (e *Env) parsed(name string, r Result) checkparse.Summary {
	var junit []byte
	if j := e.Cfg.Commands.JUnit; j != "" && (name == "test" || name == "tests") {
		p := j
		if !filepath.IsAbs(p) {
			p = filepath.Join(e.code, j)
		}
		if st, err := os.Stat(p); err == nil && !st.ModTime().Before(time.Now().Add(-time.Duration(r.Seconds*float64(time.Second))-2*time.Second)) {
			junit, _ = os.ReadFile(p)
		}
	}
	out := r.Full
	if out == "" {
		out = r.Tail
	}
	s := checkparse.Parse(out, junit)
	for i, f := range s.Failures {
		if rel, err := filepath.Rel(e.code, f.File); err == nil && filepath.IsAbs(f.File) && !strings.HasPrefix(rel, "..") {
			s.Failures[i].File = rel
		}
	}
	return s
}

// failReport is a failed command of check or finish for the agent: the parsed failures and the log (in the open run
// folder), or the tail when the output has no failures the parsers can list.
func (e *Env) failReport(name string, r Result, tail int) string {
	head := failText(name, r)
	sum := e.parsed(name, r)
	log := ""
	if run := e.currentRun(false); e.O.Change != "" && run != "" {
		log = e.writeLog(run, name, r)
	}
	if len(sum.Failures) > 0 {
		s := head + "\n" + strings.Join(sum.Lines(), "\n")
		if log != "" {
			s += "\nfull output: " + log
		}
		return s
	}
	t := r.Tail
	if len(t) > tail {
		t = t[len(t)-tail:]
	}
	return head + "\n" + t
}

// checkRun is one command of run-checks.
type checkRun struct {
	Name     string              `json:"name"`
	Cmd      string              `json:"cmd,omitempty"`
	OK       bool                `json:"ok"`
	Skipped  string              `json:"skipped,omitempty"`
	RC       int                 `json:"rc"`
	TimedOut bool                `json:"timed_out,omitempty"`
	Seconds  float64             `json:"seconds"`
	Log      string              `json:"log,omitempty"`
	Summary  *checkparse.Summary `json:"summary,omitempty"`
	Tail     []string            `json:"tail,omitempty"` // the last lines, when the output could not be read
	Problems []string            `json:"problems,omitempty"`
}

var checkNames = []string{"lint", "typecheck", "test", "visual"}

// RunChecks runs the project's lint, typecheck and test commands (and, for a change, its visual check, headless),
// each in full and uncached, writes each output to a log file and prints a short parsed summary. With a change the
// result goes to its timeline.
func (e *Env) RunChecks() error {
	only := e.O.Select
	for _, n := range only {
		if !slices.Contains(checkNames, n) {
			return die(Usage, "--only %q is not one of %s", n, strings.Join(checkNames, ", "))
		}
	}
	want := func(n string) bool { return len(only) == 0 || slices.Contains(only, n) }
	changeDir := ""
	if e.O.Change != "" {
		d, err := e.changeDir()
		if err != nil {
			return err
		}
		changeDir = d
	} else if slices.Contains(only, "visual") {
		return die(Usage, "the visual check needs a change: run-checks <change> --only visual")
	}
	cmds := append([]CmdInfo{e.cmdInfo("lint", "lint", "WINGMAN_SPEC_LINT_CMD"), e.cmdInfo("typecheck", "typecheck", "WINGMAN_SPEC_TYPECHECK_CMD")}, e.testCmd())
	cmds[2].Name = "test"
	var runs []checkRun
	seen := map[string]string{}
	for _, c := range cmds {
		if !want(c.Name) {
			continue
		}
		cr := checkRun{Name: c.Name, Cmd: c.cmd(), OK: true}
		switch {
		case c.State != "set":
			cr.Skipped = fmt.Sprintf("no command (%s in %s)", c.State, c.Source)
			if c.Name == "test" && testCmdProblem(c) != "" {
				cr.OK, cr.Problems = false, []string{testCmdProblem(c)}
			}
		case seen[norm(c.cmd())] != "":
			cr.Skipped = "same command as " + seen[norm(c.cmd())]
		default:
			seen[norm(c.cmd())] = c.Name
			r := e.runCmd(c.cmd(), e.code, e.timeoutFor(c.Name), c.Name)
			cr.OK, cr.RC, cr.TimedOut, cr.Seconds = r.RC == 0, r.RC, r.TimedOut, r.Seconds
			cr.Log = e.writeLog(e.checksDir(), c.Name, r)
			if s := e.parsed(c.Name, r); s.Read() {
				cr.Summary = &s
			}
			if !cr.OK && (cr.Summary == nil || len(cr.Summary.Failures) == 0) {
				lines := strings.Split(strings.TrimRight(r.Tail, "\n"), "\n")
				cr.Tail = lines[max(0, len(lines)-20):]
			}
		}
		runs = append(runs, cr)
	}
	if changeDir != "" && want("visual") {
		var o outcome
		t0 := time.Now()
		e.finishVisual(changeDir, e.checksDir(), &o)
		cr := checkRun{Name: "visual", OK: len(o.failures) == 0, Seconds: time.Since(t0).Seconds(), Problems: o.failures}
		if len(o.checks) == 0 && len(o.failures) == 0 {
			cr.Skipped = "no visual scenarios (or visual: off)"
		}
		runs = append(runs, cr)
	}
	var failed []string
	for _, r := range runs {
		if !r.OK {
			failed = append(failed, r.Name)
		}
	}
	ok := len(failed) == 0
	if e.O.Change != "" {
		sum := "checks passed"
		if !ok {
			sum = "checks failed: " + strings.Join(failed, ", ")
		}
		details := map[string]any{}
		for _, r := range runs {
			switch {
			case r.Skipped != "":
				details[r.Name] = "skipped"
			case r.Summary != nil:
				details[r.Name] = map[string]any{"ok": r.OK, "rc": r.RC, "counts": r.Summary.Counts()}
			default:
				details[r.Name] = map[string]any{"ok": r.OK, "rc": r.RC}
			}
		}
		e.tl(timeline.Event{Event: "checks", OK: &ok, Summary: sum, Details: details})
	}
	if e.O.Text {
		for _, r := range runs {
			fmt.Fprintln(e.Out, checkLine(r))
			if r.Summary != nil && (!r.OK || len(r.Summary.Failures) > 0) {
				for _, l := range r.Summary.Lines()[1:] {
					fmt.Fprintln(e.Out, l)
				}
			}
			for _, l := range r.Tail {
				fmt.Fprintln(e.Out, "  | "+l)
			}
			for _, p := range r.Problems {
				fmt.Fprintln(e.Out, "  "+strings.ReplaceAll(p, "\n", "\n  "))
			}
		}
		verdict := "ok"
		if !ok {
			verdict = "FAILED (" + strings.Join(failed, ", ") + ")"
		}
		fmt.Fprintf(e.Out, "run-checks: %s\n", verdict)
	} else {
		e.print(O("ok", ok, "change", orNil(e.O.Change), "checks", runs, "failed", list(failed)))
	}
	if !ok {
		return quit(Fail)
	}
	return nil
}

func checkLine(r checkRun) string {
	if r.Skipped != "" {
		if !r.OK {
			return fmt.Sprintf("%s: FAILED: %s", r.Name, r.Skipped)
		}
		return fmt.Sprintf("%s: skipped: %s", r.Name, r.Skipped)
	}
	verdict := "ok"
	switch {
	case r.TimedOut:
		verdict = "FAILED (timed out)"
	case !r.OK && r.Name == "visual":
		verdict = "FAILED"
	case !r.OK:
		verdict = fmt.Sprintf("FAILED (exit %d)", r.RC)
	}
	s := fmt.Sprintf("%s: %s, %.1fs", r.Name, verdict, r.Seconds)
	if r.Summary != nil {
		s += ": " + r.Summary.Lines()[0]
	} else if !r.OK && r.Name != "visual" {
		s += ": output not recognised, the last lines follow"
	}
	if r.Log != "" {
		s += "; log: " + r.Log
	}
	return s
}
