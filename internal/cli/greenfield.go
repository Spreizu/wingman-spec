package cli

import (
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Spreizu/wingman-spec/internal/greenfield"
)

// greenfieldCmds are mode, greenfield, roadmap and handover: the new-product flow. They parse their own arguments.
func (a *app) greenfieldCmds() []*cobra.Command {
	mk := func(use, short string) *cobra.Command {
		return &cobra.Command{
			Use: use, Short: short, DisableFlagParsing: true,
			RunE: func(c *cobra.Command, args []string) error {
				var rest []string
				for i := 0; i < len(args); i++ {
					switch {
					case args[i] == "--help" || args[i] == "-h":
						return c.Help()
					case args[i] == "--root" && i+1 < len(args):
						a.rootFlag = args[i+1]
						i++
					case strings.HasPrefix(args[i], "--root="):
						a.rootFlag = strings.TrimPrefix(args[i], "--root=")
					default:
						rest = append(rest, args[i])
					}
				}
				r, err := a.root()
				if err != nil {
					return err
				}
				e := &greenfield.Env{Out: a.out, Err: a.errOut, In: os.Stdin, Cwd: a.cwd}
				if code := greenfield.Main(greenfield.New(r), e, c.Name(), rest); code != 0 {
					return fail(code, "")
				}
				return nil
			},
		}
	}
	return []*cobra.Command{
		mk("mode", "The project mode (greenfield, brownfield, greenfield-in-progress, implementation); --for CMD exits 6 when CMD is not allowed"),
		mk("greenfield", "The new-product flow: status | start --by NAME --yes | new <kind> | approve <understood|spec> | review <spec|plan|dryrun> | readme"),
		mk("roadmap", "The roadmap check: dependency graph, order, size caps, coverage (--next: the slices ready to start)"),
		mk("handover", "The handover gate (--write records the manifest when READY)"),
	}
}
