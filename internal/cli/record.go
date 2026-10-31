package cli

import (
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// SourceEnv names what ran the CLI (the editor extension sets "editor"); it goes into the timeline.
const SourceEnv = "WINGMAN_SPEC_SOURCE"

// LogEvents are the agent-only steps `log` records.
var LogEvents = []string{"start", "explore", "grill", "approval", "note"}

// record appends the timeline event of a planning command (and of any command the editor ran for a change), after
// one artifact event per artifact written or rewritten since the last record. Commands that record their own events
// (next, check, finish, sync, archive) are not recorded here.
func (a *app) record(c *cobra.Command, code int) {
	if c == nil || c.Parent() == nil || c.Parent().Parent() != nil {
		return
	}
	cmd, args, src := c.Name(), c.Flags().Args(), os.Getenv(SourceEnv)
	planning := slices.Contains([]string{"new", "instructions", "validate", "lint", "size", "app-map"}, cmd)
	if !planning && (src != "editor" || cmd != "status") {
		return
	}
	if cmd == "instructions" && len(args) == 2 {
		args = args[1:]
	}
	if len(args) != 1 || (cmd == "new" && code != ExitOK) {
		return
	}
	r, err := a.root()
	if err != nil {
		return
	}
	dir, err := change.Dir(r, args[0])
	if err != nil {
		return
	}
	runs := r.Runs(args[0])
	timeline.Artifacts(runs, dir, cmd, src)
	ok := code == ExitOK
	sum := map[string][2]string{
		"new":          {"change created", ""},
		"instructions": {"instructions for " + c.Flags().Arg(0), "instructions refused"},
		"validate":     {"valid", "not valid"},
		"lint":         {"planning lint passed", "planning lint found problems"},
		"size":         {"size fits", "size does not fit"},
		"app-map":      {"app map", "app map refused"},
		"status":       {"status", "status failed"},
	}[cmd]
	s := sum[0]
	if !ok {
		s = fmt.Sprintf("%s (exit %d)", sum[1], code)
	}
	ev := timeline.Event{Event: cmd, Summary: s}
	if cmd != "new" && cmd != "instructions" && cmd != "status" {
		ev.OK = &ok
	}
	if src != "" {
		ev.Details = map[string]any{"source": src}
	}
	timeline.Append(runs, ev)
}

func (a *app) logCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "log <change> <event> [<summary>]",
		Short: "Record an agent step in the change's timeline: " + strings.Join(LogEvents, ", "),
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(_ *cobra.Command, args []string) error {
			if !slices.Contains(LogEvents, args[1]) {
				return fail(ExitUsage, "unknown event %q: use one of %s", args[1], strings.Join(LogEvents, ", "))
			}
			r, err := a.root()
			if err != nil {
				return err
			}
			dir, err := change.Dir(r, args[0])
			if err != nil {
				return fail(ExitUsage, "%v", err)
			}
			sum := args[1]
			if len(args) == 3 && strings.TrimSpace(args[2]) != "" {
				sum = strings.TrimSpace(args[2])
			}
			runs, src := r.Runs(args[0]), os.Getenv(SourceEnv)
			timeline.Artifacts(runs, dir, "log", src)
			timeline.Append(runs, timeline.Event{Event: args[1], Summary: sum})
			if a.json {
				return a.printJSON(map[string]any{"logged": args[1], "summary": sum})
			}
			a.printf("logged %s\n", args[1])
			return nil
		},
	}
}
