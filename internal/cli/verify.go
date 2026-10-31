package cli

import (
	"errors"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/trace"
	"github.com/Spreizu/wingman-spec/internal/verify"
)

// vflags are the verify options a command takes, bound to cobra flags.
type vflags struct {
	o       verify.Options
	testCmd string
}

const (
	fRun    = 1 << iota // --timeout --max-attempts --test-cmd --session --takeover --no-cache --timing --reason
	fNext               // --new-run --per-task --format
	fCheck              // --reported --changed-only
	fReview             // --reply --reviewer
	fVisual             // --scenario --changed-only
)

func (v *vflags) bind(c *cobra.Command, which int) {
	f := c.Flags()
	if which&fRun != 0 {
		f.IntVar(&v.o.Timeout, "timeout", v.o.Timeout, "seconds per command")
		f.IntVar(&v.o.MaxAttempts, "max-attempts", v.o.MaxAttempts, "attempts before exhausted")
		f.StringVar(&v.testCmd, "test-cmd", "", "the test command (overrides commands.test; \"none\" runs no tests)")
		f.StringVar(&v.o.Session, "session", "", "this agent session's id (env WINGMAN_SPEC_SESSION)")
		f.BoolVar(&v.o.Takeover, "takeover", false, "take over a run another session or worktree holds")
		f.BoolVar(&v.o.NoCache, "no-cache", false, "run every command even when this tree already passed it")
		f.BoolVar(&v.o.Timing, "timing", false, "print what each step cost (env WINGMAN_SPEC_PROFILE=1)")
		f.StringVar(&v.o.Reason, "reason", "", "why the plan changed (recorded in the timeline)")
	}
	if which&fNext != 0 {
		f.BoolVar(&v.o.NewRun, "new-run", false, "start a new run (abandons the open one)")
		f.BoolVar(&v.o.PerTask, "per-task", false, "one task per packet, even in a parallel group")
		f.IntVar(&v.o.Parallel, "parallel", 0, "tasks per parallel wave (1: no waves; default: parallel in wingman-spec.yaml)")
		f.StringVar(&v.o.Format, "format", v.o.Format, "json|prompt")
	}
	if which&fCheck != 0 {
		f.StringVar(&v.o.Reported, "reported", v.o.Reported, "what the implementer reported: done|failed|blocked")
	}
	if which&(fCheck|fVisual) != 0 {
		f.BoolVar(&v.o.Changed, "changed-only", false, "skip the visual check when the app is unchanged since it last passed")
	}
	if which&(fCheck|fReview) != 0 {
		f.StringVar(&v.o.Task, "task", "", "in a parallel wave: the task whose subagent returned (its label, e.g. 1.2)")
	}
	if which&fReview != 0 {
		f.StringVar(&v.o.Reply, "reply", "", "the reviewer's reply file (- reads stdin)")
		f.StringVar(&v.o.Reviewer, "reviewer", v.o.Reviewer, "subagent|none")
	}
	if which&fVisual != 0 {
		f.StringArrayVar(&v.o.Scenarios, "scenario", nil, "check this scenario id (repeatable)")
	}
}

func newVflags() *vflags { return &vflags{o: verify.Defaults()} }

// env resolves the root and config and prepares a verify run.
func (a *app) env(c *cobra.Command, v *vflags, cmd, changeName string) (*verify.Env, error) {
	r, err := a.root()
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(r.Configs...)
	if err != nil {
		if cmd == "doctor" { // checking the setup: a config problem is its finding, not a usage error
			probs := []string{err.Error()}
			if ce, ok := errors.AsType[*config.Error](err); ok { // one line per problem, each naming the file
				probs = nil
				for _, p := range ce.Problems {
					probs = append(probs, ce.File+": "+p)
				}
			}
			if perr := a.printJSON(map[string]any{"ok": false, "problems": probs}); perr != nil {
				return nil, perr
			}
			return nil, &exitError{code: ExitFail}
		}
		return nil, fail(ExitUsage, "%v", err)
	}
	o := v.o
	o.Cmd, o.Change, o.JSON = cmd, changeName, a.json
	if c.Flags().Changed("test-cmd") {
		t := v.testCmd
		o.TestCmd = &t
	}
	if err := o.Check(); err != nil {
		return nil, err
	}
	e := verify.New(r, cfg, o, a.out, a.errOut)
	e.Ctx = c.Context()
	e.Stdin = c.InOrStdin()
	return e, nil
}

// vcmd is a verify command: run builds the Env and calls do. extra binds the command's own flags.
func (a *app) vcmd(use, short string, args cobra.PositionalArgs, which int, do func(*verify.Env) error, extra ...func(*pflag.FlagSet, *verify.Options)) *cobra.Command {
	v := newVflags()
	c := &cobra.Command{Use: use, Short: short, Args: args}
	c.RunE = func(c *cobra.Command, args []string) error {
		name := ""
		if len(args) > 0 {
			name = args[0]
		}
		cmd := c.Name()
		if p := c.Parent(); p != nil && p.Parent() != nil { // a subcommand runs as its parent (anchors prune -> anchors)
			cmd = p.Name()
		}
		e, err := a.env(c, v, cmd, name)
		if err != nil {
			return err
		}
		defer e.Close()
		return do(e)
	}
	v.bind(c, which)
	for _, x := range extra {
		x(c.Flags(), &v.o)
	}
	return c
}

func (a *app) verifyCmds() []*cobra.Command {
	one := cobra.ExactArgs(1)
	opt := cobra.MaximumNArgs(1)
	run := fRun
	anchors := a.vcmd("anchors [<change>]", "Code and test anchors of every requirement (or the change's); `anchors prune` drops over-anchored markers", opt, 0, (*verify.Env).Anchors)
	var sel *string
	prune := a.vcmd("prune", "List (or --apply: remove) the markers anchor_fit flags as removable; the last code anchor stays", cobra.NoArgs, 0, func(e *verify.Env) error {
		for s := range strings.SplitSeq(*sel, ",") {
			if s = strings.TrimSpace(s); s != "" {
				e.O.Select = append(e.O.Select, s)
			}
		}
		return e.AnchorsPrune()
	}, func(f *pflag.FlagSet, o *verify.Options) {
		f.BoolVar(&o.Apply, "apply", false, "remove the markers")
		sel = f.String("select", "", "only these markers: file:line,...")
	})
	anchors.AddCommand(prune)

	drift := a.vcmd("drift", "Gaps between the living specs, code anchors and test tags; `drift decide <key> --accept --note` records an accepted gap", cobra.NoArgs, 0, (*verify.Env).Drift,
		func(f *pflag.FlagSet, o *verify.Options) {
			f.BoolVar(&o.Text, "text", false, "a readable list instead of JSON")
		})
	drift.Long = drift.Short + ".\n\nGap kinds: unanchored-requirement, untested-requirement, orphan-anchor, stale-anchor, over-anchored,\n" +
		"duplicate-marker, misplaced-marker, stale-test-tag, unsynced-archive, unconfirmed-requirement (an adopted requirement\n" +
		"without a Confirmed: line) and observed-incomplete (an entry in .wingman-spec/observed/<capability>.md that lacks a\n" +
		"field). An observed entry's `Why unconfirmed:` starts with one of: " + strings.Join(trace.ObservedKinds, ", ") + "."
	decide := &cobra.Command{Use: "decide [<gap-key>]", Short: "Accept one open gap (or --all <type>) with a note", Args: opt}
	xv := newVflags()
	decide.Flags().BoolVar(&xv.o.Accept, "accept", false, "accept the gap")
	decide.Flags().StringVar(&xv.o.Note, "note", "", "why the gap is accepted")
	decide.Flags().StringVar(&xv.o.All, "all", "", "accept every open gap of this type")
	decide.RunE = func(c *cobra.Command, args []string) error {
		if len(args) > 0 {
			xv.o.Key = args[0]
		}
		e, err := a.env(c, xv, "drift", "")
		if err != nil {
			return err
		}
		return e.DriftDecide()
	}
	drift.AddCommand(decide)

	guard := a.vcmd("guard <change>", "The anchor guard over the change's diff", one, 0, (*verify.Env).Guard,
		func(f *pflag.FlagSet, o *verify.Options) {
			f.StringVar(&o.Base, "base", "", "diff base (default: the commit `next` recorded, else HEAD)")
		})
	appMap := a.vcmd("app-map <change>", "The two-line app map of a Size S change (--apply writes app-map.md)", one, 0, (*verify.Env).AppMap,
		func(f *pflag.FlagSet, o *verify.Options) { f.BoolVar(&o.Apply, "apply", false, "write app-map.md") })
	return []*cobra.Command{
		a.vcmd("next <change>", "Hand out the next task (or parallel batch) as a packet for one implementer subagent", one, run|fNext, (*verify.Env).Next),
		a.vcmd("check <change>", "Verify the task in progress: done-when, tests, validate, visual, quality; tick it on pass", one, run|fCheck, (*verify.Env).Check),
		a.vcmd("review <change>", "Record the visual reviewer's reply for the task in progress", one, run|fReview, (*verify.Env).Review),
		a.vcmd("finish <change>", "Close-out once every task is ticked: full commands, validate, visual, trace, anchors, test evidence", one, run, (*verify.Env).Finish),
		a.vcmd("lint <change>", "Planning lint of a change (no command runs)", one, run, (*verify.Env).Lint),
		a.vcmd("size <change>", "Declared size against what the change needs", one, 0, (*verify.Env).Size),
		appMap,
		a.vcmd("visual <change>", "The implementer's visual self-check (the task in progress, or --scenario ids)", one, run|fVisual, (*verify.Env).Visual),
		a.vcmd("doctor", "Check the setup: test command, visual config, Playwright, Chromium, axe, roles, local credentials", cobra.NoArgs, run, (*verify.Env).Doctor),
		a.vcmd("design-system", "What the project already has to build a design with (tokens, components, variants)", cobra.NoArgs, 0, (*verify.Env).DesignSystem),
		anchors, drift, guard,
		a.vcmd("problems [<change>]", "Every finding as one located list, for editors (read-only)", opt, 0, (*verify.Env).Problems),
	}
}
