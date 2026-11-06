package cli

import (
	"os"
	"path/filepath"
	"strings"

	wingmanspec "github.com/Spreizu/wingman-spec"

	"github.com/Spreizu/wingman-spec/internal/artifacts"
	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/harness"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/validate"
	"github.com/Spreizu/wingman-spec/internal/verify"
)

func (a *app) rootCmd() *command {
	return &command{
		Use:   "root",
		Short: "Show where the specs and the code root are",
		Args:  noArgs,
		RunE: func(*command, []string) error {
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

func (a *app) updateCmd() *command {
	var harnesses string
	var check bool
	c := &command{
		Use:   "update",
		Short: "Refresh the generated agent files, bundled skills, AGENTS.md block and shim from this binary",
		Long: "Re-renders what `init --harness` installed for the harnesses already present (or --harness), so an upgraded\n" +
			"wingman-spec brings its commands and skills into the project. Your own files and the config are not touched.",
		Args: noArgs,
		RunE: func(*command, []string) error {
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
	lines := gitx.Lines(dir, "remote", "get-url", "origin")
	if len(lines) == 0 {
		return ""
	}
	return layout.CleanURL(lines[0])
}

func (a *app) newCmd() *command {
	return &command{
		Use:   "new <change>",
		Short: "Create a change folder",
		Args:  exactArgs(1),
		RunE: func(_ *command, args []string) error {
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

func (a *app) listCmd() *command {
	var archived bool
	c := &command{
		Use:   "list",
		Short: "List the active changes (or --archived)",
		Args:  noArgs,
		RunE: func(*command, []string) error {
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

func (a *app) statusCmd() *command {
	v := newVflags()
	c := &command{
		Use:   "status <change>",
		Short: "Show which planning artifacts the change has",
		Args:  exactArgs(1),
		RunE: func(c *command, args []string) error {
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
