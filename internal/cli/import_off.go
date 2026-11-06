//go:build !importer

package cli

import "github.com/Spreizu/wingman-spec/internal/layout"

func (a *app) importCmd() *command {
	var dir, to string
	var dry bool
	c := &command{
		Use:   "import openspec",
		Short: "Convert an OpenSpec-based project (openspec/, adr/) to .wingman-spec/",
		Args:  exactArgs(1),
		RunE: func(_ *command, args []string) error {
			return fail(ExitUsage, "import openspec is not in this binary: rebuild with -tags importer, or run the archived 0.12 binary")
		},
	}
	c.Flags().StringVar(&dir, "dir", "openspec", "the OpenSpec folder")
	c.Flags().StringVar(&to, "to", layout.Dir, "the new specs folder (\".\" for a specs repository)")
	c.Flags().BoolVar(&dry, "dry-run", false, "list the steps; write nothing")
	return c
}
