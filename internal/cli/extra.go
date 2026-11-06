package cli

import (
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/adr"
	"github.com/Spreizu/wingman-spec/internal/artifacts"
	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/validate"
	"github.com/Spreizu/wingman-spec/internal/verify"
)

func (a *app) instructionsCmd() *command {
	return &command{
		Use:   "instructions <artifact> <change>",
		Short: "Print the instruction, template and project context for one artifact (apply: the apply instruction)",
		Args:  exactArgs(2),
		RunE: func(_ *command, args []string) error {
			set := artifacts.MustLoad()
			r, d, err := a.changeDir(args[1])
			if err != nil {
				return err
			}
			cfg, err := config.Load(r.Configs...)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if args[0] == "apply" {
				if a.json {
					return a.printJSON(map[string]any{"changeName": args[1], "changeDir": d, "instruction": set.Apply.Instruction, "tracks": set.Apply.Tracks})
				}
				a.printf("%s", set.Apply.Instruction)
				return nil
			}
			art, ok := set.Get(args[0])
			if !ok {
				return fail(ExitUsage, "unknown artifact %q: use one of %s, apply", args[0], strings.Join(set.IDs(), ", "))
			}
			tpl, err := artifacts.Template(art.Template)
			if err != nil {
				return err
			}
			in := Instructions{Change: args[1], Artifact: art.ID, ChangeDir: d, OutputPath: art.Generates, Description: art.Description,
				Instruction: art.Instruction, Template: tpl, Context: cfg.Context, Rules: cfg.Rules[art.ID], Dependencies: []Dependency{}}
			for _, dep := range art.Requires {
				da, _ := set.Get(dep)
				in.Dependencies = append(in.Dependencies, Dependency{dep, artifacts.Exists(d, da.Generates) || (dep == "specs" && specsNone(d)), da.Generates})
			}
			if a.json {
				return a.printJSON(in)
			}
			a.printf("# %s for change %s\nWrite: %s\n\n", art.ID, args[1], filepath.Join(r.Rel(d), art.Generates))
			if in.Context != "" {
				a.printf("## Project context\n%s\n", in.Context)
			}
			if len(in.Rules) > 0 {
				a.printf("## Project rules\n- %s\n\n", strings.Join(in.Rules, "\n- "))
			}
			a.printf("## Instruction\n%s\n## Template\n%s", in.Instruction, in.Template)
			return nil
		},
	}
}

func (a *app) validateCmd() *command {
	var specs, all bool
	c := &command{
		Use:   "validate [<change>]",
		Short: "Validate a change (proposal, delta specs against the living specs), --specs or --all",
		Args:  maxArgs(1),
		RunE: func(_ *command, args []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			var reports []*validate.Report
			if specs || all {
				rep, err := validate.Living(r.LivingSpecs(), r.Rel)
				if err != nil {
					return err
				}
				reports = append(reports, rep)
			}
			var names []string
			switch {
			case len(args) == 1:
				names = args
			case all:
				ls, err := change.List(r)
				if err != nil {
					return err
				}
				for _, s := range ls {
					names = append(names, s.Name)
				}
			case !specs:
				return fail(ExitUsage, "name a change, or pass --specs or --all")
			}
			for _, n := range names {
				rep, err := change.Validate(r, n)
				if err != nil {
					return fail(ExitUsage, "%v", err)
				}
				tl := filepath.Join(r.Runs(n), timeline.File)
				if b := timeline.Verify(tl).Break; b != nil {
					rel, _ := filepath.Rel(r.Specs, tl)
					rep.Issues = append(rep.Issues, validate.Issue{Level: validate.Warning, File: filepath.ToSlash(rel), Line: b.Line,
						Msg: "the timeline was changed after it was written: " + b.String()})
				}
				reports = append(reports, rep)
			}
			ok := true
			for _, rep := range reports {
				ok = ok && rep.Valid
			}
			if a.json {
				if err := a.printJSON(map[string]any{"valid": ok, "items": reports}); err != nil {
					return err
				}
			} else {
				for _, rep := range reports {
					state := "valid"
					if !rep.Valid {
						state = "INVALID"
					}
					a.printf("%s: %s\n", rep.Target, state)
					for _, i := range rep.Issues {
						a.printf("  %s %s\n", i.Level, i)
					}
				}
			}
			if !ok {
				return fail(ExitFail, "")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&specs, "specs", false, "validate the living specs")
	c.Flags().BoolVar(&all, "all", false, "validate the living specs and every active change")
	return c
}

func (a *app) syncCmd() *command {
	var check, dry, rebase bool
	var c *command
	c = &command{
		Use:   "sync <change>",
		Short: "Merge the change's delta specs into the living specs and promote its ADRs (--check: report only; archive runs it)",
		Args:  exactArgs(1),
		RunE: func(_ *command, args []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			if check {
				return a.syncCheck(c, args[0])
			}
			if rebase {
				moved, err := change.Rebase(r, args[0])
				if err != nil {
					return fail(ExitUsage, "%v", err)
				}
				a.recordRebase(c, args[0], moved)
				return a.printJSON(map[string]any{"change": args[0], "rebased": moved, "next": "the base is recorded again from the living specs; run `wingman-spec archive " + args[0] + "`"})
			}
			start := time.Now()
			res, err := change.Sync(r, args[0], dry)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if !dry {
				a.recordSync(c, args[0], res.Problems, time.Since(start))
			}
			// sync is a workflow step like finish and archive: its result is always JSON
			if err := a.printJSON(res); err != nil {
				return err
			}
			if len(res.Problems) > 0 {
				return fail(ExitFail, "not synced: %d problem(s), nothing was written", len(res.Problems))
			}
			return nil
		},
	}
	c.Flags().BoolVar(&check, "check", false, "report what is not merged or promoted; write nothing")
	c.Flags().BoolVar(&dry, "dry-run", false, "show what sync would do; write nothing")
	c.Flags().BoolVar(&rebase, "rebase", false, "after updating the delta for what another change merged: record the living specs as the base again (merges nothing)")
	return c
}

// recordRebase writes the rebase event (which requirements' base moved) to the change's timeline.
func (a *app) recordRebase(c *command, name string, moved []string) {
	if e, err := a.env(c, newVflags(), "sync", name); err == nil {
		ok := true
		e.Record(timeline.Event{Event: "rebase", OK: &ok, Summary: fmt.Sprintf("spec base recorded again (%d moved)", len(moved)), Details: map[string]any{"moved": moved}})
	}
}

func (a *app) archiveCmd() *command {
	return a.vcmd("archive <change>", "Gate (tasks, findings, finish on this tree, lint, a clean merge), sync, then move the change to archive/YYYY-MM-DD-HHMM-<change>", exactArgs(1), 0, (*verify.Env).Archive)
}

// recordSync writes the sync event to the change's timeline (a record, never a gate).
func (a *app) recordSync(c *command, name string, problems []string, took time.Duration) {
	e, err := a.env(c, newVflags(), "sync", name)
	if err != nil {
		return
	}
	ok := len(problems) == 0
	sum := "specs merged and ADRs promoted"
	if !ok {
		sum = fmt.Sprintf("not synced: %d problem(s), nothing was written", len(problems))
	}
	sec := math.Round(took.Seconds()*10) / 10
	e.Record(timeline.Event{Event: "sync", OK: &ok, Seconds: &sec, Summary: sum, Details: map[string]any{"failures": problems}})
}

// syncCheck is `sync --check`: specs merged, ADRs promoted and, with traceability on, anchors and drift. Writes nothing.
func (a *app) syncCheck(c *command, name string) error {
	e, err := a.env(c, newVflags(), "sync", name)
	if err != nil {
		return err
	}
	x, ok, err := e.SyncReport()
	if err != nil {
		return err
	}
	if err := a.printJSON(x); err != nil {
		return err
	}
	if !ok {
		return fail(ExitFail, "")
	}
	return nil
}

func (a *app) configCmd() *command {
	return &command{
		Use:   "config",
		Short: "Print the merged configuration (code repo file first, then the specs root's)",
		Args:  noArgs,
		RunE: func(*command, []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			cfg, err := config.Load(r.Configs...)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			return a.printJSON(cfg)
		},
	}
}

func (a *app) adrsCmd() *command {
	var fix bool
	c := &command{
		Use:   "adrs",
		Short: "List the promoted ADRs; exit 1 when two share a number (--fix renumbers the later ones)",
		Args:  noArgs,
		RunE: func(*command, []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			var renamed []adr.Rename
			if fix {
				if renamed, err = adr.Renumber(r.ADRs()); err != nil {
					return err
				}
			}
			list, err := adr.List(r.ADRs())
			if err != nil {
				return err
			}
			dup := adr.Duplicates(r.ADRs())
			next := ""
			switch {
			case len(dup) > 0:
				next = "two ADRs share a number: run `wingman-spec adrs --fix` (the first file keeps it) and commit the renames"
			case len(renamed) > 0:
				next = "commit the renames; check that any `supersedes:` that named a renumbered ADR still points at the right one"
			}
			if a.json {
				out := map[string]any{"ok": len(dup) == 0, "adrs": nonNil(list), "duplicates": nonNil(dup)}
				if len(renamed) > 0 {
					out["renamed"] = renamed
				}
				if next != "" {
					out["next"] = next
				}
				if err := a.printJSON(out); err != nil {
					return err
				}
			} else {
				for _, x := range list {
					a.printf("%04d %-10s %s\n", x.Number, x.Status, x.Title)
				}
				for _, x := range renamed {
					a.printf("renamed: %s -> %s\n", x.From, x.To)
				}
				for _, p := range dup {
					a.printf("problem: %s\n", p)
				}
				if next != "" {
					a.printf("next: %s\n", next)
				}
			}
			if len(dup) > 0 {
				return fail(ExitFail, "")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&fix, "fix", false, "renumber duplicate ADR numbers (the first file keeps its number)")
	return c
}

func nilIfNil(o *verify.Obj) any {
	if o == nil {
		return nil
	}
	return o
}

func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}
