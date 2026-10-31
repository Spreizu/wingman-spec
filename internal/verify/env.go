// Package verify is the deterministic gate of the apply loop: `next` hands out a task, `check` decides whether it
// is done, `finish` closes the change out. It also holds the read-only reports around it (status, lint, size,
// doctor, guard, anchors, drift, problems, sync-check). Exit codes and JSON shapes are part of the harness contract.
package verify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

// Exit codes (the same as the cli package's).
const (
	OK        = 0
	Fail      = 1
	Usage     = 2
	Blocked   = 3
	Exhausted = 4
	Review    = 5
	Done      = 10
)

// Exit is a non-zero exit; Msg (when set) goes to stderr.
type Exit struct {
	Code int
	Msg  string
}

func (e *Exit) Error() string { return e.Msg }

func die(code int, format string, a ...any) error { return &Exit{code, fmt.Sprintf(format, a...)} }

// quit is an exit whose output was already printed.
func quit(code int) error {
	if code == OK {
		return nil
	}
	return &Exit{Code: code}
}

// Options are the flags of the verify commands.
type Options struct {
	Cmd, Change       string
	Timeout           int
	MaxAttempts       int
	TestCmd           *string
	Reported          string
	Format            string
	NewRun, PerTask   bool
	Parallel          int    // lanes per wave (0: the config's parallel)
	Task              string // the wave task a check or review is for
	NoCache, Changed  bool
	Timing, Takeover  bool
	Session, Reply    string
	Reviewer          string
	Scenarios         []string
	Note, Reason, All string
	Accept, JSON      bool
	Apply, Text       bool
	Base, Key         string
	Select            []string
}

// Defaults are the option defaults.
func Defaults() Options {
	return Options{Timeout: 600, MaxAttempts: 3, Reported: "done", Format: "json", Reviewer: "subagent"}
}

var (
	sessionRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
	changeRE  = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// Check validates the options that do not depend on the command.
func (o *Options) Check() error {
	if o.Session != "" && !sessionRE.MatchString(o.Session) {
		return die(Usage, "--session needs 1-64 letters, digits or . _ : -")
	}
	if !slices.Contains([]string{"done", "failed", "blocked"}, o.Reported) {
		return die(Usage, "--reported must be done|failed|blocked")
	}
	if !slices.Contains([]string{"json", "prompt"}, o.Format) {
		return die(Usage, "--format must be json|prompt")
	}
	if o.Reviewer == "self" {
		return die(Usage, "--reviewer self is not allowed: the implementer does not review its own screenshots. Dispatch an independent spec-visual-reviewer subagent, or record the review as skipped with --reviewer none")
	}
	if !slices.Contains([]string{"subagent", "none"}, o.Reviewer) {
		return die(Usage, "--reviewer must be subagent|none")
	}
	if o.Change != "" && !changeRE.MatchString(o.Change) {
		return die(Usage, "invalid change name '%s'", o.Change)
	}
	if o.Parallel < 0 {
		return die(Usage, "--parallel needs a positive integer")
	}
	if o.Timeout < 1 || o.MaxAttempts < 1 {
		return die(Usage, "--timeout and --max-attempts need a positive integer")
	}
	return nil
}

// Env is one verify command run.
type Env struct {
	R      *layout.Root
	Cfg    *config.Config
	O      Options
	Out    io.Writer
	Err    io.Writer
	Stdin  io.Reader
	Ctx    context.Context
	code   string // the code root (commands run here)
	status string // run_status of this run
	memo   *[]string
	lock   *runstate.Lock
	t0     time.Time
	wave   int // the wave and lane (1-based) this command works on, for the timeline
	lane   int
}

// New prepares a command run.
func New(r *layout.Root, cfg *config.Config, o Options, out, errOut io.Writer) *Env {
	return &Env{R: r, Cfg: cfg, O: o, Out: out, Err: errOut, Stdin: os.Stdin, Ctx: context.Background(), code: r.Code, t0: time.Now()}
}

func (e *Env) say(format string, a ...any) { fmt.Fprintf(e.Err, "wingman-spec: "+format+"\n", a...) }

func (e *Env) tr() trace.Ctx { return trace.Ctx{R: e.R, Cfg: e.Cfg} }

// print writes v as indented JSON (keys in order for *Obj).
func (e *Env) print(v any) {
	b, err := marshal(v)
	if err != nil {
		e.say("cannot write JSON: %v", err)
		return
	}
	var out bytes.Buffer
	if err := json.Indent(&out, b, "", "  "); err != nil {
		out.Reset()
		out.Write(b)
	}
	out.WriteByte('\n')
	_, _ = e.Out.Write(out.Bytes())
}

// emit prints a result of next/check/review/finish/sync: it adds run_status and writes the timeline event.
func (e *Env) emit(x *Obj) {
	if e.status != "" && !x.Has("run_status") {
		x.Set("run_status", e.status)
	}
	e.timelineOf(x)
	e.print(x)
	if e.O.Timing || os.Getenv("WINGMAN_SPEC_PROFILE") == "1" {
		e.profile()
	}
}

// profile prints the steps of this command, most expensive first, and records them in the run's metrics.jsonl.
func (e *Env) profile() {
	steps := runstate.Profile()
	if len(steps) == 0 {
		return
	}
	parts := make([]string, 0, 12)
	for _, s := range steps[:min(len(steps), 12)] {
		p := fmt.Sprintf("%s %gs", s.Step, s.Seconds)
		if s.N > 1 {
			p += fmt.Sprintf(" (%dx)", s.N)
		}
		parts = append(parts, p)
	}
	fmt.Fprintf(e.Err, "wingman-spec: timing (%s): %s\n", e.O.Cmd, strings.Join(parts, " | "))
	if run := e.currentRun(false); run != "" {
		logMetric(run, O("event", "profile", "cmd", e.O.Cmd, "steps", steps))
	}
}

// ---------- change and tasks ----------

func (e *Env) changeDir() (string, error) {
	d, err := change.Dir(e.R, e.O.Change)
	if err != nil {
		return "", die(Usage, "%v", err)
	}
	return d, nil
}

// taskRef is one checkbox of tasks.md, as the verifier tracks it.
type taskRef struct {
	Desc string
	Done bool
	T    *tasks.Task
	File string
}

// Progress is the task count.
type Progress struct {
	Total     int `json:"total"`
	Complete  int `json:"complete"`
	Remaining int `json:"remaining"`
}

func tasksFile(changeDir string) string { return filepath.Join(changeDir, "tasks.md") }

func describe(t *tasks.Task) string { return strings.TrimSpace(t.Label + " " + t.Title) }

// loadTasks reads tasks.md: the tasks in file order and the progress.
func loadTasks(changeDir string) ([]taskRef, Progress, error) {
	f := tasksFile(changeDir)
	b, err := os.ReadFile(f)
	if err != nil {
		return nil, Progress{}, die(Usage, "%s has no tasks.md (is the tasks artifact created?)", filepath.Base(changeDir))
	}
	var out []taskRef
	p := Progress{}
	for _, t := range tasks.Parse(string(b)).All() {
		out = append(out, taskRef{Desc: describe(t), Done: t.Done, T: t, File: f})
		p.Total++
		if t.Done {
			p.Complete++
		}
	}
	p.Remaining = p.Total - p.Complete
	return out, p, nil
}

func readText(f string) string {
	b, _ := os.ReadFile(f)
	return string(b)
}

func exists(f string) bool { _, err := os.Stat(f); return err == nil }

// ---------- project commands ----------

// CmdInfo is a project command and where it came from. State: set | none | placeholder | absent.
type CmdInfo struct {
	Name   string  `json:"name,omitempty"`
	Cmd    *string `json:"cmd"`
	Source string  `json:"source"`
	State  string  `json:"state"`
}

func (c CmdInfo) cmd() string {
	if c.Cmd == nil {
		return ""
	}
	return *c.Cmd
}

var noneRE = regexp.MustCompile(`(?i)^(none|off|n/a)$`)

// cmdInfo resolves one project command: env var, then the config's `commands:` key.
func (e *Env) cmdInfo(name, key, env string) CmdInfo {
	if v, ok := os.LookupEnv(env); ok {
		if v == "" {
			return CmdInfo{Name: name, Source: env, State: "none"}
		}
		return CmdInfo{Name: name, Cmd: new(v), Source: env, State: "set"}
	}
	val := map[string]string{"test": e.Cfg.Commands.Test, "typecheck": e.Cfg.Commands.Typecheck, "lint": e.Cfg.Commands.Lint, "targeted": e.Cfg.Commands.Targeted}[key]
	src := e.Cfg.Sources["commands."+key]
	if src == "" {
		src = e.configFile()
	}
	src = e.R.Rel(src)
	v := strings.Trim(strings.TrimSpace(val), "`")
	switch {
	case v == "":
		return CmdInfo{Name: name, Source: src, State: "absent"}
	case noneRE.MatchString(v):
		return CmdInfo{Name: name, Source: src, State: "none"}
	case v == config.Placeholder || strings.Contains(strings.ToLower(v), "fill in") || (strings.HasPrefix(v, "<") && strings.HasSuffix(v, ">")):
		return CmdInfo{Name: name, Source: src, State: "placeholder"}
	}
	return CmdInfo{Name: name, Cmd: new(v), Source: src, State: "set"}
}

// configFile is the config file a missing key belongs in (the code repo's own file first).
func (e *Env) configFile() string {
	if len(e.R.Configs) > 0 {
		return e.R.Configs[0]
	}
	return filepath.Join(e.R.State(), layout.ConfigFile)
}

// testCmd is the project test command: --test-cmd, WINGMAN_SPEC_TEST_CMD, then `commands.test`.
func (e *Env) testCmd() CmdInfo {
	if e.O.TestCmd != nil {
		if *e.O.TestCmd == "" {
			return CmdInfo{Source: "--test-cmd", State: "none"}
		}
		return CmdInfo{Cmd: new(*e.O.TestCmd), Source: "--test-cmd", State: "set"}
	}
	c := e.cmdInfo("", "test", "WINGMAN_SPEC_TEST_CMD")
	c.Name = ""
	return c
}

func testCmdProblem(c CmdInfo) string {
	switch c.State {
	case "placeholder":
		return fmt.Sprintf("the project test command in %s is still the %s placeholder, so no task could be checked against the project's tests. Set `commands: test: <command>` (e.g. `npm test`, `pytest`), or `test: none` to opt out, or pass --test-cmd.", c.Source, config.Placeholder)
	case "absent":
		return fmt.Sprintf("no `commands: test:` in %s. Add `test: <command>` under `commands:` (or `test: none`), or pass --test-cmd.", c.Source)
	}
	return ""
}

func (e *Env) extraCmds() []CmdInfo {
	return []CmdInfo{e.cmdInfo("typecheck", "typecheck", "WINGMAN_SPEC_TYPECHECK_CMD"), e.cmdInfo("lint", "lint", "WINGMAN_SPEC_LINT_CMD")}
}

func envOr(env, cfg string) string {
	if v, ok := os.LookupEnv(env); ok {
		return v
	}
	return cfg
}

var (
	finishRE = regexp.MustCompile(`(?i)^\s*(finish|at finish|finish[- ]only)\s*$`)
	taskRE   = regexp.MustCompile(`(?i)^\s*(task|per[- ]task|each task)\s*$`)
	groupRE  = regexp.MustCompile(`(?i)^\s*(group|per[- ]group)\s*$`)
)

// testRun is `commands.test_run`: each (default) or finish.
func (e *Env) testRun() string {
	if finishRE.MatchString(envOr("WINGMAN_SPEC_TEST_RUN", e.Cfg.Commands.TestRun)) {
		return "finish"
	}
	return "each"
}

// checkLevel is `commands.check_level`: targeted (default) | group | task | finish.
func (e *Env) checkLevel() string {
	v := envOr("WINGMAN_SPEC_CHECK_LEVEL", e.Cfg.Commands.CheckLevel)
	switch {
	case finishRE.MatchString(v):
		return "finish"
	case taskRE.MatchString(v):
		return "task"
	case groupRE.MatchString(v):
		return "group"
	}
	return "targeted"
}

var fileRE = regexp.MustCompile(`[\w./-]+\.[a-z]{1,5}\b`)

var splitRE = regexp.MustCompile(`\s*(?:&&|\|\||;)\s*`)

// doneWhenParts are the commands a `Done when:` line runs (so `npm test && npm run lint` covers both).
func doneWhenParts(cmd string) []string {
	var out []string
	for _, p := range splitRE.Split(cmd, -1) {
		if p = norm(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func norm(s string) string { return strings.Join(strings.Fields(s), " ") }

// ---------- git and the working tree ----------

// changedFiles is `git status` minus the specs (memoised until a command runs); nil without git.
func (e *Env) changedFiles() []string {
	if e.memo != nil {
		return *e.memo
	}
	st := runstate.Timed("git status", func() []string { return gitx.Status(e.code) })
	if st == nil {
		return nil
	}
	tr := e.tr()
	out := []string{}
	for _, f := range st {
		if tr.IsSpecPath(f) || strings.HasPrefix(f, layout.Dir+"/") {
			continue
		}
		out = append(out, f)
	}
	e.memo = &out
	return out
}

// runsDir is the change's gitignored run directory (created).
func (e *Env) runsDir() string {
	base := filepath.Dir(e.R.Runs(e.O.Change))
	_ = os.MkdirAll(base, 0o755)
	if gi := filepath.Join(base, ".gitignore"); !exists(gi) {
		_ = os.WriteFile(gi, []byte("*\n"), 0o644)
	}
	d := e.R.Runs(e.O.Change)
	_ = os.MkdirAll(d, 0o755)
	return d
}

// changeBase is the commit the change's first run started from (recorded by `next`).
func (e *Env) changeBase() string {
	return strings.TrimSpace(readText(filepath.Join(e.R.Runs(e.O.Change), "base")))
}

func (e *Env) recordBase() {
	f := filepath.Join(e.runsDir(), "base")
	if exists(f) {
		return
	}
	if h := gitx.Head(e.code); h != "" {
		_ = os.WriteFile(f, []byte(h+"\n"), 0o644)
	}
}

// ---------- timeline ----------

func (e *Env) sessionPtr() *string {
	s := e.O.Session
	if s == "" {
		s = os.Getenv("WINGMAN_SPEC_SESSION")
	}
	if s == "" {
		return nil
	}
	return &s
}

// Record appends an event to the change's timeline (the session is filled in when unset).
func (e *Env) Record(ev timeline.Event) { e.tl(ev) }

func (e *Env) tl(ev timeline.Event) {
	if ev.Session == nil {
		ev.Session = e.sessionPtr()
	}
	if ev.Wave == 0 && e.wave > 0 {
		ev.Wave, ev.Lane = e.wave, e.lane
	}
	timeline.Append(e.R.Runs(e.O.Change), ev)
}

func (e *Env) decide(task string) {
	d, err := change.Dir(e.R, e.O.Change)
	if err != nil {
		return
	}
	_ = os.MkdirAll(e.R.Runs(e.O.Change), 0o755)
	timeline.Decide(e.R.Runs(e.O.Change), d, timeline.Ctx{Reason: e.O.Reason, Task: task, Cmd: e.O.Cmd, Session: e.sessionPtr()})
}

var (
	filesLineRE = regexp.MustCompile(`(?i)^Files:\s*`)
	filesSepRE  = regexp.MustCompile(`[\s,;]+`)
	filesStrip  = strings.NewReplacer("`", "", "(", "", ")", "")
)

// filesOf is the `Files:` detail line as paths.
func filesOf(details []string) []string {
	out := []string{}
	for _, d := range details {
		if !filesLineRE.MatchString(d) {
			continue
		}
		for _, x := range filesSepRE.Split(filesLineRE.ReplaceAllString(d, ""), -1) {
			if x = filesStrip.Replace(x); strings.ContainsAny(x, "./") {
				out = append(out, x)
			}
		}
		break
	}
	return out
}
