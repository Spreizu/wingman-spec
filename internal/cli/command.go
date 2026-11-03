package cli

import (
	"cmp"
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

// command is one CLI command: a flag.FlagSet of its own, a check on its positional arguments and its subcommands.
// Flags may come before or after the arguments (`archive my-change --yes`); `--` ends them.
type command struct {
	Use, Short, Long string
	Args             argCheck
	RunE             func(c *command, args []string) error
	Raw              bool // the command parses its own arguments (greenfield): nothing is parsed or checked here

	parent *command
	subs   []*command
	fs     *flagSet
	global *flagSet // the root's flags, which every command accepts (--json, --root)
	args   []string // the positional arguments of the run
	out    io.Writer
}

// flagSet is a flag.FlagSet with the helpers the commands use.
type flagSet struct{ *flag.FlagSet }

// argCheck refuses a wrong number of positional arguments.
type argCheck func(c *command, args []string) error

func noArgs(c *command, args []string) error {
	if len(args) > 0 {
		return fmt.Errorf("unknown command %q for %q", args[0], c.path())
	}
	return nil
}

func exactArgs(n int) argCheck {
	return func(_ *command, args []string) error {
		if len(args) != n {
			return fmt.Errorf("accepts %d arg(s), received %d", n, len(args))
		}
		return nil
	}
}

func maxArgs(n int) argCheck {
	return func(_ *command, args []string) error {
		if len(args) > n {
			return fmt.Errorf("accepts at most %d arg(s), received %d", n, len(args))
		}
		return nil
	}
}

func rangeArgs(lo, hi int) argCheck {
	return func(_ *command, args []string) error {
		if len(args) < lo || len(args) > hi {
			return fmt.Errorf("accepts between %d and %d arg(s), received %d", lo, hi, len(args))
		}
		return nil
	}
}

// stringsValue is a repeatable string flag.
type stringsValue struct{ p *[]string }

func (s stringsValue) String() string {
	if s.p == nil || len(*s.p) == 0 {
		return "[]"
	}
	return "[" + strings.Join(*s.p, ",") + "]"
}
func (s stringsValue) Set(v string) error { *s.p = append(*s.p, v); return nil }

// StringArrayVar binds a repeatable string flag.
func (f *flagSet) StringArrayVar(p *[]string, name string, def []string, usage string) {
	*p = def
	f.Var(stringsValue{p}, name, usage)
}

// Changed reports whether the command line set the flag.
func (f *flagSet) Changed(name string) bool {
	set := false
	f.Visit(func(x *flag.Flag) { set = set || x.Name == name })
	return set
}

func (c *command) Name() string { n, _, _ := strings.Cut(c.Use, " "); return n }

func (c *command) Parent() *command { return c.parent }

func (c *command) path() string {
	if c.parent == nil {
		return c.Name()
	}
	return c.parent.path() + " " + c.Name()
}

// Flags are the command's own flags.
func (c *command) Flags() *flagSet {
	if c.fs == nil {
		c.fs = &flagSet{flag.NewFlagSet(c.Name(), flag.ContinueOnError)}
		c.fs.SetOutput(io.Discard)
	}
	return c.fs
}

func (c *command) AddCommand(cs ...*command) {
	for _, s := range cs {
		s.parent = c
		c.subs = append(c.subs, s)
	}
}

func (c *command) sub(name string) *command {
	for _, s := range c.subs {
		if s.Name() == name {
			return s
		}
	}
	return nil
}

func (c *command) root() *command {
	for c.parent != nil {
		c = c.parent
	}
	return c
}

// lookup finds a flag of the command or a global one.
func (c *command) lookup(name string) (*flag.Flag, *flagSet) {
	if f := c.Flags().Lookup(name); f != nil {
		return f, c.fs
	}
	if g := c.root().global; g != nil {
		if f := g.Lookup(name); f != nil {
			return f, g
		}
	}
	return nil, nil
}

func isBool(f *flag.Flag) bool {
	b, ok := f.Value.(interface{ IsBoolFlag() bool })
	return ok && b.IsBoolFlag()
}

var errHelp = errors.New("help requested")
var errVersion = errors.New("version requested")

// parse sets the flags in args and returns the positional arguments in order.
func (c *command) parse(args []string) ([]string, error) {
	var pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			return append(pos, args[i+1:]...), nil
		case !strings.HasPrefix(a, "-") || a == "-":
			pos = append(pos, a)
			continue
		case !strings.HasPrefix(a, "--"):
			switch {
			case a == "-h":
				return nil, errHelp
			case a == "-v" && c.parent == nil:
				return nil, errVersion
			}
			return nil, fmt.Errorf("unknown shorthand flag: %q in %s", rune(a[1]), a)
		}
		name, val, hasVal := strings.Cut(a[2:], "=")
		if name == "help" {
			return nil, errHelp
		}
		if name == "version" && c.parent == nil {
			return nil, errVersion
		}
		f, fs := c.lookup(name)
		if f == nil {
			return nil, fmt.Errorf("unknown flag: --%s", name)
		}
		switch {
		case hasVal:
		case isBool(f):
			val = "true"
		case i+1 < len(args):
			i++
			val = args[i]
		default:
			return nil, fmt.Errorf("flag needs an argument: --%s", name)
		}
		if err := fs.Set(name, val); err != nil {
			return nil, fmt.Errorf("invalid argument %q for %q flag: %w", val, "--"+name, parseCause(f, val, err))
		}
	}
	return pos, nil
}

// parseCause is the strconv error behind a refused value (its text names the value and why it does not parse).
func parseCause(f *flag.Flag, val string, err error) error {
	var perr error
	switch f.Value.(flag.Getter).Get().(type) {
	case int:
		_, perr = strconv.ParseInt(val, 0, 64)
	case bool:
		_, perr = strconv.ParseBool(val)
	}
	return cmp.Or(perr, err)
}

// find walks the command names in args down from c (flags may come before them) and returns the command and the
// remaining arguments.
func (c *command) find(args []string) (*command, []string) {
	cur, rest := c, args
	for !cur.Raw {
		i := 0
		for i < len(rest) && strings.HasPrefix(rest[i], "--") && rest[i] != "--" {
			name, _, hasVal := strings.Cut(rest[i][2:], "=")
			if f, _ := cur.lookup(name); f != nil && !hasVal && !isBool(f) {
				i++
			}
			i++
		}
		if i >= len(rest) {
			break
		}
		s := cur.sub(rest[i])
		if s == nil {
			break
		}
		cur, rest = s, append(slices.Clip(rest[:i]), rest[i+1:]...)
	}
	return cur, rest
}

// execute runs the command line and returns the command that ran.
func (c *command) execute(args []string) (*command, error) {
	if len(args) > 0 && args[0] == "help" {
		cur, rest := c.find(args[1:])
		if len(rest) > 0 {
			fmt.Fprintf(c.out, "Unknown help topic %#q\n", rest)
			c.usage()
			return c, nil
		}
		cur.help()
		return cur, nil
	}
	cur, rest := c.find(args)
	if cur.Raw {
		cur.args = rest
		return cur, cur.RunE(cur, rest)
	}
	pos, err := cur.parse(rest)
	switch {
	case errors.Is(err, errHelp):
		cur.help()
		return cur, nil
	case errors.Is(err, errVersion):
		fmt.Fprintf(c.out, "%s version %s\n", c.Name(), Version)
		return cur, nil
	case err != nil:
		return cur, err
	}
	cur.args = pos
	if cur.RunE == nil {
		if cur.parent == nil && len(pos) > 0 {
			return cur, fmt.Errorf("unknown command %q for %q", pos[0], cur.path())
		}
		cur.help()
		return cur, nil
	}
	if cur.Args != nil {
		if err := cur.Args(cur, pos); err != nil {
			return cur, err
		}
	}
	return cur, cur.RunE(cur, pos)
}

// Help prints the command's help.
func (c *command) Help() error { c.help(); return nil }

func (c *command) help() {
	if t := strings.TrimRight(cmp.Or(c.Long, c.Short), " \t\n"); t != "" {
		fmt.Fprintf(c.root().out, "%s\n\n", t)
	}
	if c.RunE != nil || len(c.subs) > 0 || c.parent == nil {
		c.usage()
	}
}

// usage prints how to call the command: its subcommands and flags.
func (c *command) usage() {
	var b strings.Builder
	runnable := c.RunE != nil
	b.WriteString("Usage:")
	if runnable {
		b.WriteString("\n  " + c.useLine() + " [flags]")
	}
	cmds, topics := c.children()
	if len(cmds) > 0 {
		b.WriteString("\n  " + c.path() + " [command]")
	}
	if len(cmds) > 0 {
		b.WriteString("\n\nAvailable Commands:")
		w := 11
		for _, s := range cmds {
			w = max(w, len(s.Name()))
		}
		for _, s := range cmds {
			fmt.Fprintf(&b, "\n  %-*s %s", w, s.Name(), s.Short)
		}
	}
	local := []flagLine{{"-h, --help", "", "help for " + c.Name()}}
	c.Flags().VisitAll(func(f *flag.Flag) { local = append(local, line(f)) })
	if c.parent == nil {
		c.global.VisitAll(func(f *flag.Flag) { local = append(local, line(f)) })
		local = append(local, flagLine{"-v, --version", "", "version for " + c.Name()})
	}
	slices.SortStableFunc(local, func(x, y flagLine) int { return cmp.Compare(x.key(), y.key()) })
	b.WriteString("\n\nFlags:\n" + flagTable(local))
	if c.parent != nil {
		var g []flagLine
		c.root().global.VisitAll(func(f *flag.Flag) { g = append(g, line(f)) })
		b.WriteString("\nGlobal Flags:\n" + flagTable(g))
	}
	if len(topics) > 0 {
		b.WriteString("\nAdditional help topics:")
		w := 0
		for _, s := range topics {
			w = max(w, len(s.path()))
		}
		for _, s := range topics {
			fmt.Fprintf(&b, "\n  %-*s %s", w+4, s.path(), s.Short)
		}
		b.WriteString("\n")
	}
	if len(cmds) > 0 {
		fmt.Fprintf(&b, "\nUse \"%s [command] --help\" for more information about a command.\n", c.path())
	}
	fmt.Fprintf(c.root().out, "%s", b.String())
}

func (c *command) useLine() string {
	if c.parent == nil {
		return c.Use
	}
	return c.parent.path() + " " + c.Use
}

// children are the subcommands (the root also lists help) and the help topics (reference), by name.
func (c *command) children() (cmds, topics []*command) {
	for _, s := range c.subs {
		if s.RunE == nil && !s.Raw && len(s.subs) == 0 {
			topics = append(topics, s)
		} else {
			cmds = append(cmds, s)
		}
	}
	if c.parent == nil {
		cmds = append(cmds, &command{Use: "help", Short: "Help about any command"})
	}
	byName := func(x, y *command) int { return cmp.Compare(x.Name(), y.Name()) }
	slices.SortFunc(cmds, byName)
	slices.SortFunc(topics, byName)
	return cmds, topics
}

type flagLine struct{ names, typ, usage string }

func (l flagLine) key() string {
	return strings.TrimLeft(l.names[strings.LastIndex(l.names, " ")+1:], "-")
}

func line(f *flag.Flag) flagLine {
	l := flagLine{names: "--" + f.Name, usage: f.Usage}
	if v, ok := f.Value.(stringsValue); ok {
		l.typ = "stringArray"
		if len(*v.p) > 0 {
			l.usage += " (default " + v.String() + ")"
		}
		return l
	}
	switch f.Value.(flag.Getter).Get().(type) {
	case bool:
		if f.DefValue == "true" {
			l.usage += " (default true)"
		}
	case int:
		l.typ = "int"
		if f.DefValue != "0" {
			l.usage += " (default " + f.DefValue + ")"
		}
	default:
		l.typ = "string"
		if f.DefValue != "" {
			l.usage += fmt.Sprintf(" (default %q)", f.DefValue)
		}
	}
	// a `name` in the usage names the value in the help
	if i := strings.Index(l.usage, "`"); i >= 0 && l.typ != "" {
		if j := strings.Index(l.usage[i+1:], "`"); j >= 0 {
			l.typ = l.usage[i+1 : i+1+j]
			l.usage = l.usage[:i] + l.typ + l.usage[i+2+j:]
		}
	}
	return l
}

func flagTable(ls []flagLine) string {
	cols := make([]string, len(ls))
	w := 0
	for i, l := range ls {
		cols[i] = "  " + l.names
		if !strings.HasPrefix(l.names, "-") || !strings.Contains(l.names, ",") {
			cols[i] = "      " + l.names
		}
		if l.typ != "" {
			cols[i] += " " + l.typ
		}
		w = max(w, len(cols[i]))
	}
	var b strings.Builder
	for i, l := range ls {
		fmt.Fprintf(&b, "%-*s   %s\n", w, cols[i], l.usage)
	}
	return b.String()
}
