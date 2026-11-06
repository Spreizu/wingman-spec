//go:build importer

package cli

import (
	"path/filepath"

	"github.com/Spreizu/wingman-spec/internal/importer"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/scaffold"
)

func (a *app) importCmd() *command {
	var dir, to string
	var dry bool
	c := &command{
		Use:   "import openspec",
		Short: "Convert an OpenSpec-based project (openspec/, adr/) to .wingman-spec/",
		Args:  exactArgs(1),
		RunE: func(_ *command, args []string) error {
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
