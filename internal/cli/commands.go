package cli

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	wingmanspec "github.com/Spreizu/wingman-spec"

	"github.com/Spreizu/wingman-spec/internal/adr"
	"github.com/Spreizu/wingman-spec/internal/artifacts"
	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/detect"
	"github.com/Spreizu/wingman-spec/internal/greenfield"
	"github.com/Spreizu/wingman-spec/internal/harness"
	"github.com/Spreizu/wingman-spec/internal/importer"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/scaffold"
	"github.com/Spreizu/wingman-spec/internal/timeline"
	"github.com/Spreizu/wingman-spec/internal/validate"
	"github.com/Spreizu/wingman-spec/internal/verify"
)

func (a *app) rootCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "root",
		Short: "Show where the specs and the code root are",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			if a.json {
				return a.printJSON(r)
			}
			a.printf("layout: %s\nspecs:  %s\ncode:   %s\n", r.Kind, r.Specs, r.Code)
			return nil
		},
	}
}

func (a *app) initCmd() *cobra.Command {
	var o scaffold.Options
	var harnesses, workspaceFile string
	var noDetect bool
	c := &cobra.Command{
		Use:   "init",
		Short: "Create the Wingman Spec skeleton and install it for your coding agents",
		Long: "Layouts:\n  repo   specs next to the code, in .wingman-spec/ (default)\n" +
			"  specs  a separate specs repository: specs at its root\n" +
			"  link   a code repository whose specs live in a specs repository (--specs ../specs)\n\n" +
			"--harness cursor,claude,codex (or all) installs the /spec-* commands, subagents and bundled skills\n" +
			"for those agents and keeps the AGENTS.md block current. The test, typecheck, lint and visual commands are\n" +
			"detected from the code; a detected typecheck or lint command runs once and is left out when it fails\n" +
			"(WINGMAN_SPEC_INIT_PROBE=0 skips that run). Existing files are kept; `wingman-spec update` refreshes the\n" +
			"generated ones after an upgrade.",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			hs, err := harness.ParseList(harnesses)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if o.Layout == scaffold.Link && o.SpecsRemote == "" && o.SpecsPath != "" {
				o.SpecsRemote = gitRemote(filepath.Join(a.cwd, o.SpecsPath))
			}
			var det detect.Result
			if o.Layout != scaffold.Specs && !noDetect {
				det = detect.Detect(a.cwd, true)
				o.Test, o.Typecheck, o.Lint, o.Visual, o.URL = det.Test, det.Typecheck, det.Lint, det.Visual, det.URL
			}
			wrote, err := scaffold.Init(a.cwd, o)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			res, err := harness.Install(a.cwd, wingmanspec.Harness(), wingmanspec.Skills(), harness.Options{Harnesses: hs, Exe: executable()})
			if err != nil {
				return fail(ExitFail, "%v", err)
			}
			if r, err := layout.Find(a.cwd, ""); err == nil && r.Kind != layout.Linked {
				if line := greenfield.New(r).InputsReadme(); line != "" {
					res.Lines = append(res.Lines, line)
				}
			}
			if workspaceFile != "" {
				if o.Layout != scaffold.Link {
					return fail(ExitUsage, "--workspace-file needs --layout link --specs <path>")
				}
				wf, _ := filepath.Abs(filepath.Join(a.cwd, workspaceFile))
				if filepath.IsAbs(workspaceFile) {
					wf = workspaceFile
				}
				line, err := harness.Workspace(wf, a.cwd, filepath.Clean(filepath.Join(a.cwd, o.SpecsPath)))
				if err != nil {
					return fail(ExitFail, "%v", err)
				}
				res.Lines = append(res.Lines, line)
			}
			if a.json {
				return a.printJSON(map[string]any{"layout": o.Layout, "wrote": nonNil(wrote), "harnesses": nonNil(hs), "detected": det, "steps": nonNil(res.Lines)})
			}
			if len(wrote) > 0 {
				a.printf("Wrote:\n  %s\n", strings.Join(wrote, "\n  "))
			} else {
				a.printf("The skeleton exists (kept as it is).\n")
			}
			for _, l := range res.Lines {
				a.printf("%s\n", l)
			}
			for _, n := range det.Notes {
				a.printf("commands    -> %s: left out (fix it, then set it in %s)\n", n, layout.ConfigFile)
			}
			for _, w := range wrote {
				if strings.HasSuffix(w, ".yaml") {
					a.printf("Next: fill in the <fill in> values of %s.\n", w)
					break
				}
			}
			if len(hs) == 0 {
				a.printf("No coding agent set up: add --harness cursor,claude,codex (or all) to install the /spec-* commands.\n")
			}
			return nil
		},
	}
	c.Flags().StringVar(&o.Layout, "layout", scaffold.Repo, "repo | specs | link")
	c.Flags().StringVar(&o.SpecsPath, "specs", "", "link layout: the specs repository, relative to this directory")
	c.Flags().StringVar(&o.SpecsRemote, "specs-remote", "", "link layout: the specs repository's git URL (default: its origin)")
	c.Flags().StringVar(&harnesses, "harness", "", "coding agents to install for: cursor,claude,codex or all")
	c.Flags().StringVar(&workspaceFile, "workspace-file", "", "link layout: also write a .code-workspace that opens the code and the specs folders")
	c.Flags().BoolVar(&noDetect, "no-detect", false, "do not detect the project's commands (keep the <fill in> placeholders)")
	return c
}

func (a *app) updateCmd() *cobra.Command {
	var harnesses string
	var check bool
	c := &cobra.Command{
		Use:   "update",
		Short: "Refresh the generated agent files, bundled skills, AGENTS.md block and shim from this binary",
		Long: "Re-renders what `init --harness` installed for the harnesses already present (or --harness), so an upgraded\n" +
			"wingman-spec brings its commands and skills into the project. Your own files and the config are not touched.",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			dir := a.cwd
			if r, err := a.root(); err == nil {
				dir = r.Code
			}
			hs, err := harness.ParseList(harnesses)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if len(hs) == 0 {
				hs = harness.Installed(dir)
			}
			if check {
				stale, err := harness.Stale(dir, wingmanspec.Harness(), hs)
				if err != nil {
					return fail(ExitFail, "%v", err)
				}
				if a.json {
					return a.printJSON(map[string]any{"dir": dir, "harnesses": nonNil(hs), "stale": nonNil(stale)})
				}
				for _, f := range stale {
					a.printf("stale %s\n", f)
				}
				if len(stale) == 0 {
					a.printf("Generated agent files are current.\n")
				}
				return nil
			}
			res, err := harness.Install(dir, wingmanspec.Harness(), wingmanspec.Skills(), harness.Options{Harnesses: hs, Exe: executable()})
			if err != nil {
				return fail(ExitFail, "%v", err)
			}
			if a.json {
				return a.printJSON(map[string]any{"dir": dir, "harnesses": nonNil(hs), "steps": nonNil(res.Lines)})
			}
			for _, l := range res.Lines {
				a.printf("%s\n", l)
			}
			if len(hs) == 0 {
				a.printf("No harness installed here: run `wingman-spec init --harness cursor,claude,codex`.\n")
			}
			return nil
		},
	}
	c.Flags().StringVar(&harnesses, "harness", "", "harnesses to refresh (default: the ones installed)")
	c.Flags().BoolVar(&check, "check", false, "write nothing; list the generated files that update would rewrite")
	return c
}

// executable is the running binary (the shim's target); empty when unknown.
func executable() string {
	if p := os.Getenv("WINGMAN_SPEC_SHIM_TARGET"); p != "" {
		return p
	}
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	return p
}

// gitRemote is dir's origin URL without credentials ("" when there is none).
func gitRemote(dir string) string {
	out, err := exec.Command("git", "-C", dir, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return layout.CleanURL(strings.TrimSpace(string(out)))
}

func (a *app) newCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "new <change>",
		Short: "Create a change folder",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			d, err := change.New(r, args[0])
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if a.json {
				return a.printJSON(map[string]string{"change": args[0], "dir": d})
			}
			a.printf("Created %s\n", r.Rel(d))
			return nil
		},
	}
}

func (a *app) listCmd() *cobra.Command {
	var archived bool
	c := &cobra.Command{
		Use:   "list",
		Short: "List the active changes (or --archived)",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			if archived {
				names, err := change.Archived(r)
				if err != nil {
					return err
				}
				if a.json {
					return a.printJSON(map[string]any{"archived": nonNil(names)})
				}
				for _, n := range names {
					a.printf("%s\n", n)
				}
				return nil
			}
			ls, err := change.List(r)
			if err != nil {
				return err
			}
			if a.json {
				return a.printJSON(map[string]any{"changes": ls})
			}
			if len(ls) == 0 {
				a.printf("No active changes.\n")
			}
			for _, s := range ls {
				a.printf("%-32s %d/%d tasks  %s\n", s.Name, s.CompletedTasks, s.TotalTasks, s.Status)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&archived, "archived", false, "list the archive folders instead")
	return c
}

func (a *app) changeDir(name string) (*layout.Root, string, error) {
	r, err := a.root()
	if err != nil {
		return nil, "", err
	}
	d, err := change.Dir(r, name)
	if err != nil {
		return nil, "", fail(ExitUsage, "%v", err)
	}
	return r, d, nil
}

func specsNone(dir string) bool {
	b, _ := os.ReadFile(filepath.Join(dir, "proposal.md"))
	return validate.SpecsNone(string(b))
}

func (a *app) statusCmd() *cobra.Command {
	v := newVflags()
	c := &cobra.Command{
		Use:   "status <change>",
		Short: "Show which planning artifacts the change has",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			_, d, err := a.changeDir(args[0])
			if err != nil {
				return err
			}
			st := artifacts.MustLoad().Status(d, specsNone(d))
			e, err := a.env(c, v, "status", args[0])
			if err != nil {
				return err
			}
			apply, err := e.RunStatus()
			if err != nil {
				return err
			}
			if a.json {
				return a.printJSON(struct {
					artifacts.ChangeStatus
					Apply any `json:"apply,omitempty"`
				}{st, nilIfNil(apply)})
			}
			for _, x := range st.Artifacts {
				extra := ""
				if len(x.MissingDeps) > 0 {
					extra = " (needs " + strings.Join(x.MissingDeps, ", ") + ")"
				}
				a.printf("%-8s %-9s %s%s\n", x.Status, x.ID, x.OutputPath, extra)
			}
			if apply != nil {
				p, _ := apply.Get("progress").(verify.Progress)
				a.printf("tasks    %d/%d done; next: %v; run: %v\n", p.Complete, p.Total, apply.Get("next"), apply.Get("run_status"))
			}
			return nil
		},
	}
	c.Flags().StringVar(&v.o.Session, "session", "", "this agent session's id (env WINGMAN_SPEC_SESSION): whose run the status describes")
	return c
}

// Instructions is what an agent needs to write one artifact.
type Instructions struct {
	Change       string       `json:"changeName"`
	Artifact     string       `json:"artifactId"`
	ChangeDir    string       `json:"changeDir"`
	OutputPath   string       `json:"outputPath"`
	Description  string       `json:"description"`
	Instruction  string       `json:"instruction"`
	Template     string       `json:"template"`
	Context      string       `json:"context,omitempty"`
	Rules        []string     `json:"rules,omitempty"`
	Dependencies []Dependency `json:"dependencies"`
}

// Dependency is an artifact the instructions build on.
type Dependency struct {
	ID   string `json:"id"`
	Done bool   `json:"done"`
	Path string `json:"path"`
}

func (a *app) instructionsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "instructions <artifact> <change>",
		Short: "Print the instruction, template and project context for one artifact (apply: the apply instruction)",
		Args:  cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
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

func (a *app) validateCmd() *cobra.Command {
	var specs, all bool
	c := &cobra.Command{
		Use:   "validate [<change>]",
		Short: "Validate a change (proposal, delta specs against the living specs), --specs or --all",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
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

func (a *app) syncCmd() *cobra.Command {
	var check, dry bool
	var c *cobra.Command
	c = &cobra.Command{
		Use:   "sync <change>",
		Short: "Merge the change's delta specs into the living specs and promote its ADRs (--check: report only)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			r, err := a.root()
			if err != nil {
				return err
			}
			if check {
				return a.syncCheck(c, args[0])
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
	return c
}

func (a *app) archiveCmd() *cobra.Command {
	return a.vcmd("archive <change>", "Move a finished, fully synced change to archive/YYYY-MM-DD-HHMM-<change> (keeps its timeline)", cobra.ExactArgs(1), 0, (*verify.Env).Archive)
}

// recordSync writes the sync event to the change's timeline (a record, never a gate).
func (a *app) recordSync(c *cobra.Command, name string, problems []string, took time.Duration) {
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
func (a *app) syncCheck(c *cobra.Command, name string) error {
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

func (a *app) importCmd() *cobra.Command {
	var dir, to string
	var dry bool
	c := &cobra.Command{
		Use:   "import openspec",
		Short: "Convert an OpenSpec-based project (openspec/, adr/) to .wingman-spec/",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if args[0] != "openspec" {
				return fail(ExitUsage, "import %q: the only source is openspec", args[0])
			}
			p, err := importer.Build(a.cwd, dir, to)
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			if !dry {
				if err := importer.Apply(a.cwd, p); err != nil {
					return err
				}
				kind := scaffold.Repo
				if filepath.Clean(to) == "." {
					kind = scaffold.Specs // a specs repository: wingman-spec.yaml and the specs at its root
				}
				if _, err := scaffold.Init(a.cwd, scaffold.Options{Layout: kind}); err != nil {
					return err
				}
			}
			if a.json {
				return a.printJSON(map[string]any{"applied": !dry, "steps": p.Steps, "warnings": p.Warnings})
			}
			for _, s := range p.Steps {
				a.printf("%-6s %s%s\n", s.Op, s.To, map[bool]string{true: " <- " + s.From, false: ""}[s.From != ""])
			}
			for _, w := range p.Warnings {
				a.printf("warning: %s\n", w)
			}
			if dry {
				a.printf("Dry run: nothing written.\n")
			}
			return nil
		},
	}
	c.Flags().StringVar(&dir, "dir", "openspec", "the OpenSpec folder")
	c.Flags().StringVar(&to, "to", layout.Dir, "the new specs folder (\".\" for a specs repository)")
	c.Flags().BoolVar(&dry, "dry-run", false, "list the steps; write nothing")
	return c
}

func (a *app) configCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "config",
		Short: "Print the merged configuration (code repo file first, then the specs root's)",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
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

func (a *app) adrsCmd() *cobra.Command {
	var fix bool
	c := &cobra.Command{
		Use:   "adrs",
		Short: "List the promoted ADRs; exit 1 when two share a number (--fix renumbers the later ones)",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
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
