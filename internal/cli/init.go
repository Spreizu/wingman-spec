package cli

import (
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	wingmanspec "github.com/Spreizu/wingman-spec"

	"github.com/Spreizu/wingman-spec/internal/detect"
	"github.com/Spreizu/wingman-spec/internal/greenfield"
	"github.com/Spreizu/wingman-spec/internal/harness"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/scaffold"
)

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
