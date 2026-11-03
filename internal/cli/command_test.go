package cli

import (
	"bytes"
	"flag"
	"slices"
	"strings"
	"testing"
)

// Flags come before or after the arguments, as --x y, --x=y or a bare bool; -- ends them; the root's flags work anywhere.
func TestCommandParse(t *testing.T) {
	var got []string
	var yes, js bool
	var name string
	var scen []string
	root := &command{Use: "ws", out: &bytes.Buffer{}}
	root.global = &flagSet{flag.NewFlagSet("global", flag.ContinueOnError)}
	root.global.BoolVar(&js, "json", false, "")
	c := &command{Use: "archive <change>", Args: exactArgs(1), RunE: func(_ *command, args []string) error { got = args; return nil }}
	c.Flags().BoolVar(&yes, "yes", false, "")
	c.Flags().StringVar(&name, "name", "", "")
	c.Flags().StringArrayVar(&scen, "scenario", nil, "")
	root.AddCommand(c)
	for _, args := range [][]string{
		{"archive", "my-change", "--yes", "--name", "n", "--scenario", "a", "--scenario=b", "--json"},
		{"--json", "archive", "--name=n", "--yes", "--scenario", "a", "my-change", "--scenario", "b"},
	} {
		got, yes, js, name, scen = nil, false, false, "", nil
		c.fs = nil
		c.Flags().BoolVar(&yes, "yes", false, "")
		c.Flags().StringVar(&name, "name", "", "")
		c.Flags().StringArrayVar(&scen, "scenario", nil, "")
		if _, err := root.execute(args); err != nil || !slices.Equal(got, []string{"my-change"}) || !yes || !js || name != "n" || !slices.Equal(scen, []string{"a", "b"}) || !c.Flags().Changed("name") || c.Flags().Changed("nope") {
			t.Errorf("%q: err %v args %q yes %v json %v name %q scenario %q", args, err, got, yes, js, name, scen)
		}
	}
	if _, err := root.execute([]string{"archive", "--", "--yes"}); err != nil || !slices.Equal(got, []string{"--yes"}) {
		t.Errorf("after --: %v %q", err, got)
	}
	for args, want := range map[string]string{
		"archive":               "accepts 1 arg(s), received 0",
		"archive a --nope":      "unknown flag: --nope",
		"archive a -x":          "unknown shorthand flag: 'x' in -x",
		"archive a --name":      "flag needs an argument: --name",
		"archive a --yes=maybe": `invalid argument "maybe" for "--yes" flag: strconv.ParseBool`,
		"bogus":                 `unknown command "bogus" for "ws"`,
	} {
		if _, err := root.execute(strings.Fields(args)); err == nil || !strings.Contains(err.Error(), want) || !isUsage(err) {
			t.Errorf("%s: %v, want %s", args, err, want)
		}
	}
}

// --help prints the command's help, also after its arguments; the root prints its version.
func TestCommandHelp(t *testing.T) {
	for args, want := range map[string]string{
		"list --help":        "Usage:\n  wingman-spec list [flags]",
		"new x -h":           "Create a change folder",
		"help anchors prune": "--select string",
		"--version":          "wingman-spec version " + Version,
		"":                   "Available Commands:",
		"help reference":     "EXIT CODES",
	} {
		if r := run(t, t.TempDir(), strings.Fields(args)...); r.code != 0 || !strings.Contains(r.out, want) {
			t.Errorf("%q = %+v, want %q", args, r, want)
		}
	}
}
