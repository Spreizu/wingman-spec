// Package config reads wingman-spec.yaml. Several files can apply (a code repo's own file first, then the specs
// root's); each key is taken from the first file that sets it, and `commands:` and `visual:` are merged per key.
package config

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Placeholder is the value `init` writes for a command the user still has to fill in.
const Placeholder = "<fill in>"

// Config is the merged configuration.
type Config struct {
	Context         string              `yaml:"context" json:"context,omitempty"`
	Language        string              `yaml:"language" json:"language,omitempty"`
	Commands        Commands            `yaml:"commands" json:"commands"`
	Traceability    string              `yaml:"traceability" json:"traceability"`
	AnchorPlacement string              `yaml:"anchor_placement" json:"anchor_placement"`
	AnchorGuard     string              `yaml:"anchor_guard" json:"anchor_guard"`
	AnchorFit       string              `yaml:"anchor_fit" json:"anchor_fit"`
	AnchorMax       int                 `yaml:"anchor_max" json:"anchor_max"`
	AnchorMany      []string            `yaml:"anchor_many" json:"anchor_many,omitempty"`
	TestEvidence    string              `yaml:"test_evidence" json:"test_evidence"`
	AnchorStale     string              `yaml:"anchor_stale" json:"anchor_stale"`
	Parallel        int                 `yaml:"parallel" json:"parallel"`
	Visual          Visual              `yaml:"visual" json:"visual"`
	Rules           map[string][]string `yaml:"rules" json:"rules,omitempty"`
	Specs           string              `yaml:"specs" json:"specs,omitempty"`
	SpecsRemote     string              `yaml:"specs_remote" json:"specs_remote,omitempty"`
	Repos           map[string]string   `yaml:"repos" json:"repos,omitempty"`

	// Sources maps a key ("commands.test", "visual.url", "traceability") to the file it came from.
	Sources map[string]string `yaml:"-" json:"sources,omitempty"`
	// Problems are values that were ignored, with the reason (typos and bad values are errors instead).
	Problems []string `yaml:"-" json:"problems,omitempty"`
}

// Commands are the project's own commands. "" means not set, "none" disables one, Placeholder means not filled in.
type Commands struct {
	Test       string `yaml:"test" json:"test,omitempty"`
	Typecheck  string `yaml:"typecheck" json:"typecheck,omitempty"`
	Lint       string `yaml:"lint" json:"lint,omitempty"`
	Targeted   string `yaml:"targeted" json:"targeted,omitempty"`
	TestRun    string `yaml:"test_run" json:"test_run,omitempty"`
	CheckLevel string `yaml:"check_level" json:"check_level,omitempty"`
}

// Visual is the `visual:` section. `visual: off` sets Off.
type Visual struct {
	Off               bool            `yaml:"-" json:"off"`
	Present           bool            `yaml:"-" json:"present"`
	Command           string          `yaml:"command" json:"command,omitempty"`
	URL               string          `yaml:"url" json:"url,omitempty"`
	Port              int             `yaml:"port" json:"port,omitempty"`
	ReadyTimeout      float64         `yaml:"ready_timeout" json:"ready_timeout"`
	PageTimeout       float64         `yaml:"page_timeout" json:"page_timeout"`
	RequestTimeout    float64         `yaml:"request_timeout" json:"request_timeout"`
	Contexts          int             `yaml:"contexts" json:"contexts"`
	Baseline          bool            `yaml:"baseline" json:"baseline"`
	Scope             string          `yaml:"scope" json:"scope"`
	ChangedOnly       bool            `yaml:"changed_only" json:"changed_only"`
	RequirePlaywright bool            `yaml:"require_playwright" json:"require_playwright"`
	IgnoreHTTPSErrors bool            `yaml:"ignore_https_errors" json:"ignore_https_errors"`
	Review            string          `yaml:"review" json:"review"`
	Screenshots       string          `yaml:"screenshots" json:"screenshots"`
	ReuseServer       bool            `yaml:"reuse_server" json:"reuse_server"`
	BrowsersPath      string          `yaml:"browsers_path" json:"browsers_path,omitempty"`
	UIFiles           []string        `yaml:"ui_files" json:"ui_files,omitempty"`
	Ignore            []string        `yaml:"ignore" json:"ignore,omitempty"`
	IgnoreHTTP        []string        `yaml:"ignore_http" json:"ignore_http,omitempty"`
	Roles             map[string]Role `yaml:"-" json:"roles,omitempty"`
	Placeholders      []string        `yaml:"-" json:"placeholders,omitempty"`
}

// Role is one gated-feature login of `visual.roles`.
type Role struct {
	Name          string `json:"name"`
	Login         string `json:"login,omitempty"`
	Success       string `json:"success,omitempty"`
	UserField     string `json:"user_field,omitempty"`
	PasswordField string `json:"password_field,omitempty"`
	Submit        string `json:"submit,omitempty"`
	UserEnv       string `json:"user_env,omitempty"`
	PasswordEnv   string `json:"password_env,omitempty"`
	StorageState  string `json:"storage_state,omitempty"`
	LoginCommand  string `json:"login_command,omitempty"`
	HeadersEnv    string `json:"headers_env,omitempty"`
}

// Defaults returns a Config with every default applied.
func Defaults() *Config {
	return &Config{
		Traceability: "on", AnchorPlacement: "warn", AnchorGuard: "warn", AnchorFit: "warn", AnchorMax: 6,
		TestEvidence: "warn", AnchorStale: "info", Parallel: 3,
		Visual: Visual{ReadyTimeout: 120, PageTimeout: 5, RequestTimeout: 3, Contexts: 4, Scope: "task", ChangedOnly: true,
			IgnoreHTTPSErrors: true, Review: "off", Screenshots: "affected"},
		Sources: map[string]string{},
	}
}

// Error is a config file that cannot be read, with every problem found.
type Error struct {
	File     string
	Problems []string
}

func (e *Error) Error() string { return e.File + ": " + strings.Join(e.Problems, "; ") }

// Load reads the files (highest priority first). Missing files are skipped.
func Load(files ...string) (*Config, error) {
	c := Defaults()
	var layers []layer
	for _, f := range files {
		b, err := os.ReadFile(f)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		l, err := parse(f, b)
		if err != nil {
			return nil, err
		}
		layers = append(layers, l)
	}
	// lowest priority first, so a higher file overwrites per key
	for _, l := range slices.Backward(layers) {
		if err := c.apply(l); err != nil {
			return nil, err
		}
	}
	c.finishVisual()
	return c, nil
}

// layer is one file: its top-level keys as YAML nodes.
type layer struct {
	file string
	keys map[string]*yaml.Node
	line map[string]int
}

func parse(file string, b []byte) (layer, error) {
	l := layer{file: file, keys: map[string]*yaml.Node{}, line: map[string]int{}}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return l, &Error{file, []string{err.Error()}}
	}
	if len(doc.Content) == 0 {
		return l, nil
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return l, &Error{file, []string{"the file must be a map of keys"}}
	}
	if dups := duplicateKeys(root, ""); len(dups) > 0 {
		return l, &Error{file, dups}
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		k := root.Content[i].Value
		l.keys[k] = root.Content[i+1]
		l.line[k] = root.Content[i].Line
	}
	return l, nil
}

var known = map[string]bool{
	"context": true, "language": true, "commands": true, "traceability": true, "anchor_placement": true,
	"anchor_guard": true, "anchor_fit": true, "anchor_max": true, "anchor_many": true, "test_evidence": true,
	"anchor_stale": true, "parallel": true, "visual": true, "rules": true, "specs": true, "specs_remote": true, "repos": true,
}

var enums = map[string][]string{
	"traceability": {"on", "warn", "off"}, "anchor_placement": {"warn", "error", "off"}, "anchor_guard": {"warn", "error", "off"},
	"anchor_fit": {"warn", "error", "off"}, "test_evidence": {"warn", "strict", "off"}, "anchor_stale": {"info", "warn", "error", "off"},
}

func (c *Config) apply(l layer) error {
	var probs []string
	for _, k := range slices.Sorted(maps.Keys(l.keys)) {
		n := l.keys[k]
		if !known[k] {
			probs = append(probs, fmt.Sprintf("line %d: unknown key %q", l.line[k], k))
			continue
		}
		var err error
		switch k {
		case "commands":
			err = c.applyCommands(l.file, n)
		case "visual":
			err = c.applyVisual(l.file, n)
		default:
			err = c.applyScalar(k, n)
			c.Sources[k] = l.file
		}
		if err != nil {
			probs = append(probs, fmt.Sprintf("line %d: %s: %s", l.line[k], k, explain(err)))
		}
	}
	if len(probs) > 0 {
		return &Error{l.file, probs}
	}
	return nil
}

func (c *Config) applyScalar(k string, n *yaml.Node) error {
	if allowed, ok := enums[k]; ok {
		v := strings.ToLower(n.Value)
		if v == "true" {
			v = "on"
		}
		if v == "false" {
			v = "off"
		}
		if !slices.Contains(allowed, v) {
			return fmt.Errorf("%q is not one of %s", n.Value, strings.Join(allowed, ", "))
		}
		n = &yaml.Node{Kind: yaml.ScalarNode, Value: v}
	}
	switch k {
	case "context":
		return n.Decode(&c.Context)
	case "language":
		return n.Decode(&c.Language)
	case "traceability":
		c.Traceability = n.Value
	case "anchor_placement":
		c.AnchorPlacement = n.Value
	case "anchor_guard":
		c.AnchorGuard = n.Value
	case "anchor_fit":
		c.AnchorFit = n.Value
	case "test_evidence":
		c.TestEvidence = n.Value
	case "anchor_stale":
		c.AnchorStale = n.Value
	case "anchor_max":
		return positive(n, &c.AnchorMax)
	case "parallel":
		return positive(n, &c.Parallel)
	case "anchor_many":
		return n.Decode(&c.AnchorMany)
	case "rules":
		return strict(n, &c.Rules)
	case "specs":
		return n.Decode(&c.Specs)
	case "specs_remote":
		return n.Decode(&c.SpecsRemote)
	case "repos":
		return strict(n, &c.Repos)
	}
	return nil
}

func positive(n *yaml.Node, dst *int) error {
	v, err := strconv.Atoi(n.Value)
	if err != nil || v < 1 {
		return fmt.Errorf("%q: write a whole number of 1 or more", n.Value)
	}
	*dst = v
	return nil
}

// strict decodes n into dst, rejecting unknown fields.
func strict(n *yaml.Node, dst any) error {
	b, err := yaml.Marshal(n)
	if err != nil {
		return err
	}
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	return d.Decode(dst)
}

var checkLevels = []string{"targeted", "group", "task", "finish"}

func (c *Config) applyCommands(file string, n *yaml.Node) error {
	if n.Kind != yaml.MappingNode {
		return errors.New("write a map: test, typecheck, lint, targeted, test_run, check_level")
	}
	var cmds Commands
	if err := strict(n, &cmds); err != nil {
		return err
	}
	set := func(key string, dst *string, v string) {
		if v != "" {
			*dst = strings.TrimSpace(v)
			c.Sources["commands."+key] = file
		}
	}
	set("test", &c.Commands.Test, cmds.Test)
	set("typecheck", &c.Commands.Typecheck, cmds.Typecheck)
	set("lint", &c.Commands.Lint, cmds.Lint)
	set("targeted", &c.Commands.Targeted, cmds.Targeted)
	if cmds.TestRun != "" && cmds.TestRun != "finish" {
		return fmt.Errorf("commands.test_run %q: the only value is finish", cmds.TestRun)
	}
	set("test_run", &c.Commands.TestRun, cmds.TestRun)
	if cmds.CheckLevel != "" && !slices.Contains(checkLevels, cmds.CheckLevel) {
		return fmt.Errorf("commands.check_level %q is not one of %s", cmds.CheckLevel, strings.Join(checkLevels, ", "))
	}
	set("check_level", &c.Commands.CheckLevel, cmds.CheckLevel)
	return nil
}

// visualFile is the YAML shape of `visual:` (roles are read separately to give the role messages).
type visualFile struct {
	Command           *string   `yaml:"command"`
	URL               *string   `yaml:"url"`
	Port              *int      `yaml:"port"`
	ReadyTimeout      *float64  `yaml:"ready_timeout"`
	PageTimeout       *float64  `yaml:"page_timeout"`
	RequestTimeout    *float64  `yaml:"request_timeout"`
	Contexts          *int      `yaml:"contexts"`
	Baseline          *string   `yaml:"baseline"`
	Scope             *string   `yaml:"scope"`
	ChangedOnly       *string   `yaml:"changed_only"`
	RequirePlaywright *bool     `yaml:"require_playwright"`
	IgnoreHTTPSErrors *bool     `yaml:"ignore_https_errors"`
	Review            *string   `yaml:"review"`
	Screenshots       *string   `yaml:"screenshots"`
	ReuseServer       *bool     `yaml:"reuse_server"`
	BrowsersPath      *string   `yaml:"browsers_path"`
	UIFiles           *[]string `yaml:"ui_files"`
	Ignore            *[]string `yaml:"ignore"`
	IgnoreHTTP        *[]string `yaml:"ignore_http"`
	Roles             yaml.Node `yaml:"roles"`
}

var (
	offWords = regexp.MustCompile(`(?i)^(off|none|false|no|0)$`)
	onWords  = regexp.MustCompile(`(?i)^(on|true|yes|new-only|1)$`)
	allWords = regexp.MustCompile(`(?i)^(all|every|guards?)$`)
	noneOff  = regexp.MustCompile(`(?i)^(none|off)$`)
)

func (c *Config) applyVisual(file string, n *yaml.Node) error {
	v := &c.Visual
	if n.Kind == yaml.ScalarNode {
		if !offWords.MatchString(n.Value) {
			return fmt.Errorf("%q: write `off` or a map of settings", n.Value)
		}
		*v = Defaults().Visual
		v.Off, v.Present = true, true
		c.Sources["visual"] = file
		return nil
	}
	CommaLists(n)
	if err := visualNumbers(n); err != nil {
		return err
	}
	var f visualFile
	if err := strict(n, &f); err != nil {
		return err
	}
	v.Off, v.Present = false, true
	src := func(k string) { c.Sources["visual."+k] = file }
	// a placeholder command/url in a repo's own file stays unset instead of falling back to another repo's app
	if f.Command != nil {
		v.Command, v.Placeholders = placeholderless(*f.Command, "command", v.Placeholders)
		src("command")
	}
	if f.URL != nil {
		v.URL, v.Placeholders = placeholderless(*f.URL, "url", v.Placeholders)
		src("url")
	}
	if f.Port != nil {
		v.Port = *f.Port
		src("port")
	}
	if f.ReadyTimeout != nil {
		v.ReadyTimeout = *f.ReadyTimeout
		src("ready_timeout")
	}
	if f.PageTimeout != nil {
		if *f.PageTimeout <= 0 {
			return fmt.Errorf("visual.page_timeout %v: write a number of seconds above 0 (default 5)", *f.PageTimeout)
		}
		v.PageTimeout = *f.PageTimeout
		src("page_timeout")
	}
	if f.Contexts != nil {
		if *f.Contexts < 1 || *f.Contexts > 16 {
			return fmt.Errorf("visual.contexts %d: write a number from 1 to 16 (default 4)", *f.Contexts)
		}
		v.Contexts = *f.Contexts
		src("contexts")
	}
	if f.RequestTimeout != nil {
		if *f.RequestTimeout < 0 {
			return fmt.Errorf("visual.request_timeout %v: write a number of seconds (0 = no limit; default 3)", *f.RequestTimeout)
		}
		v.RequestTimeout = *f.RequestTimeout
		src("request_timeout")
	}
	if f.Baseline != nil {
		v.Baseline = onWords.MatchString(*f.Baseline)
		src("baseline")
	}
	if f.Scope != nil {
		v.Scope = "task"
		if allWords.MatchString(*f.Scope) {
			v.Scope = "all"
		}
		src("scope")
	}
	if f.ChangedOnly != nil {
		v.ChangedOnly = !offWords.MatchString(*f.ChangedOnly)
		src("changed_only")
	}
	if f.RequirePlaywright != nil {
		v.RequirePlaywright = *f.RequirePlaywright
		src("require_playwright")
	}
	if f.IgnoreHTTPSErrors != nil {
		v.IgnoreHTTPSErrors = *f.IgnoreHTTPSErrors
		src("ignore_https_errors")
	}
	if f.Review != nil {
		v.Review = "off"
		if strings.EqualFold(*f.Review, "subagent") {
			v.Review = "subagent"
		}
		src("review")
	}
	if f.Screenshots != nil {
		v.Screenshots = "affected"
		if offWords.MatchString(*f.Screenshots) {
			v.Screenshots = "off"
		}
		src("screenshots")
	}
	if f.ReuseServer != nil {
		v.ReuseServer = *f.ReuseServer
		src("reuse_server")
	}
	if f.BrowsersPath != nil && *f.BrowsersPath != Placeholder {
		v.BrowsersPath = *f.BrowsersPath
		src("browsers_path")
	}
	if f.UIFiles != nil {
		v.UIFiles = nil
		for _, x := range *f.UIFiles {
			if x = strings.TrimLeft(x, "*."); x != "" {
				v.UIFiles = append(v.UIFiles, x)
			}
		}
		src("ui_files")
	}
	var probs []string
	if f.Ignore != nil {
		vals, p := checkList("ignore", *f.Ignore, CheckIgnore)
		v.Ignore, probs = vals, append(probs, p...)
		src("ignore")
	}
	if f.IgnoreHTTP != nil {
		vals, p := checkList("ignore_http", *f.IgnoreHTTP, CheckIgnoreHTTP)
		v.IgnoreHTTP, probs = vals, append(probs, p...)
		src("ignore_http")
	}
	if f.Roles.Kind != 0 {
		roles, p := parseRoles(&f.Roles)
		v.Roles, probs = roles, append(probs, p...)
		src("roles")
	}
	if len(probs) > 0 {
		return errors.New(strings.Join(probs, "; "))
	}
	return nil
}

// CommaLists turns a comma-separated string under visual's list keys into a list: old configs wrote
// `ui_files: vue, svelte`.
func CommaLists(visual *yaml.Node) {
	for i := 0; visual.Kind == yaml.MappingNode && i+1 < len(visual.Content); i += 2 {
		v := visual.Content[i+1]
		if !slices.Contains([]string{"ui_files", "ignore", "ignore_http"}, visual.Content[i].Value) || v.Kind != yaml.ScalarNode || v.Tag == "!!null" {
			continue
		}
		seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle, Line: v.Line, Column: v.Column}
		for x := range strings.SplitSeq(v.Value, ",") {
			if x = strings.TrimSpace(x); x != "" {
				seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: x})
			}
		}
		visual.Content[i+1] = seq
	}
}

// duplicateKeys lists the keys written twice in one map, at any depth. The YAML decoder rejects them with a line
// counted from the section, not the file, and without the key's path.
func duplicateKeys(n *yaml.Node, path string) []string {
	var out []string
	first := map[string]int{}
	for i, c := range n.Content {
		if n.Kind != yaml.MappingNode {
			out = append(out, duplicateKeys(c, path)...)
			continue
		}
		if i%2 == 1 {
			out = append(out, duplicateKeys(c, path+n.Content[i-1].Value+".")...)
			continue
		}
		if at, ok := first[c.Value]; ok {
			out = append(out, fmt.Sprintf("line %d: %s%s is written twice (first at line %d); keep one and delete the other", c.Line, path, c.Value, at))
		} else {
			first[c.Value] = c.Line
		}
	}
	return out
}

var (
	decodeLine = regexp.MustCompile(`(yaml: )?(unmarshal errors:)?\s*line \d+: `)
	cannotInto = regexp.MustCompile("cannot unmarshal !!(\\w+)(?: `([^`]*)`)? into (\\S+)")
	noField    = regexp.MustCompile(`field (\S+) not found in type \S+`)
	yamlKinds  = map[string]string{"str": "text", "seq": "a list", "map": "a map", "int": "a number", "float": "a number", "bool": "true/false"}
)

// explain rewrites a YAML decode error as what is wrong and how to write it. The decoder's own line numbers count
// from the section, so they are dropped (the caller reports the section's line).
func explain(err error) string {
	var parts []string
	for _, s := range decodeLine.Split(err.Error(), -1) {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		s = noField.ReplaceAllString(s, `unknown key "$1"`)
		if m := cannotInto.FindStringSubmatch(s); m != nil {
			want := "write one value"
			switch {
			case strings.HasPrefix(m[3], "[]"):
				want = `write a list, one "- value" per line`
			case strings.HasPrefix(m[3], "map["):
				want = "write a map of keys"
			case m[3] == "int" || m[3] == "float64":
				want = "write a number"
			case m[3] == "bool":
				want = "write true or false"
			}
			if m[2] != "" {
				m[2] = fmt.Sprintf(" %q", m[2])
			}
			s = fmt.Sprintf("found %s%s; %s", cmp.Or(yamlKinds[m[1]], m[1]), m[2], want)
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "; ")
}

// visualNumbers names the key of a limit that is not a number (the YAML decoder would only name the line), and of an
// ignore list without values.
func visualNumbers(n *yaml.Node) error {
	if n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		k, val := n.Content[i].Value, n.Content[i+1]
		switch k {
		case "port", "ready_timeout", "page_timeout", "request_timeout", "contexts":
			if val.Kind != yaml.ScalarNode || (val.Tag != "!!int" && val.Tag != "!!float") {
				return fmt.Errorf("visual.%s %q: write a number", k, val.Value)
			}
		case "ignore", "ignore_http":
			if val.Kind == yaml.ScalarNode && val.Tag == "!!null" {
				return fmt.Errorf("visual.%s has no values: list one per line (\"- value\") or remove the key", k)
			}
		}
	}
	return nil
}

func placeholderless(v, key string, ph []string) (string, []string) {
	v = strings.TrimSpace(v)
	if v == "" || v == Placeholder {
		return "", append(ph, key)
	}
	return v, slices.DeleteFunc(ph, func(s string) bool { return s == key })
}

func (c *Config) finishVisual() {
	v := &c.Visual
	if noneOff.MatchString(v.Command) {
		v.Off = true
	}
	if v.URL == "" && v.Port > 0 {
		v.URL = fmt.Sprintf("http://127.0.0.1:%d/", v.Port)
	}
	if v.URL != "" && v.Port == 0 {
		u, err := url.Parse(v.URL)
		switch {
		case err != nil || u.Host == "":
			v.Placeholders, v.URL = append(v.Placeholders, "url"), ""
		case u.Port() != "":
			v.Port, _ = strconv.Atoi(u.Port())
		case u.Scheme == "https":
			v.Port = 443
		default:
			v.Port = 80
		}
	}
	if v.Present && !v.Off {
		if v.Command == "" && !slices.Contains(v.Placeholders, "command") {
			v.Placeholders = append(v.Placeholders, "command")
		}
		if v.URL == "" && !slices.Contains(v.Placeholders, "url") {
			v.Placeholders = append(v.Placeholders, "url")
		}
		if v.URL != "" {
			v.Placeholders = slices.DeleteFunc(v.Placeholders, func(s string) bool { return s == "url" })
		}
	}
}

func checkList(key string, items []string, check func(string) (string, error)) ([]string, []string) {
	var vals, probs []string
	if len(items) == 0 {
		probs = append(probs, fmt.Sprintf("visual.%s has no values: list one per line (\"- value\") or remove the key", key))
	}
	for _, it := range items {
		v, err := check(it)
		if err != nil {
			probs = append(probs, fmt.Sprintf("visual.%s: %v", key, err))
			continue
		}
		if !slices.Contains(vals, v) {
			vals = append(vals, v)
		}
	}
	return vals, probs
}

var (
	ignorePrefixes  = []string{"a11y:", "runtime:", "content:"}
	ignoreExact     = []string{"layout:horizontal-overflow", "runtime:console-error", "runtime:page-error", "runtime:request-failed", "runtime:http-error", "content:broken-image"}
	ignoreCommentRE = regexp.MustCompile(`\s+#.*$`)
	colonsRE        = regexp.MustCompile(`^:+$`)
	wildRE          = regexp.MustCompile(`[\s*?,]`)
	axeRuleRE       = regexp.MustCompile(`^a11y:[a-z0-9][a-z0-9-]*$`)
	ownCodeRE       = regexp.MustCompile(`^(layout:key-|layout:overlap|design:|role:|state:|server:|regression:)`)
	alnumRE         = regexp.MustCompile(`(?i)[a-z0-9]`)
	bareHTTPRE      = regexp.MustCompile(`(?i)^https?:?(//)?$`)
)

const ignoreAllowed = "a11y:<rule> or a11y:, runtime:console-error, runtime:page-error, runtime:request-failed, runtime:http-error or runtime:, content:broken-image or content:, layout:horizontal-overflow"

// CheckIgnore validates one ignore: value (a trailing " # comment" is dropped): the code, or why it is refused.
func CheckIgnore(raw string) (string, error) {
	v := strings.TrimSpace(ignoreCommentRE.ReplaceAllString(raw, ""))
	switch {
	case v == "":
		return "", errors.New(`empty ignore value: name a defect code, e.g. "ignore: a11y:" or "ignore: runtime:console-error"`)
	case colonsRE.MatchString(v):
		return "", fmt.Errorf("ignore \"%s\" matches nothing useful: write the class before the colon, e.g. \"a11y:\"", v)
	case wildRE.MatchString(v):
		return "", fmt.Errorf("ignore \"%s\": a defect code has no spaces, commas or wildcards (one code per ignore line; a trailing \":\" means every code of that class)", v)
	case strings.HasSuffix(v, ":"):
		if slices.Contains(ignorePrefixes, v) {
			return v, nil
		}
		return "", fmt.Errorf("ignore \"%s\" is refused: it covers defects that prove the scenario's own expectation. A prefix may only be %s; name the single code for anything else (allowed: %s)", v, strings.Join(ignorePrefixes, ", "), ignoreAllowed)
	case slices.Contains(ignoreExact, v) || axeRuleRE.MatchString(v):
		return v, nil
	case ownCodeRE.MatchString(v):
		return "", fmt.Errorf("ignore \"%s\" is refused: that defect is the scenario's own expectation failing (a key element, expect, absent, redirect, role, state or server problem), so it cannot be skipped. Fix the page or the scenario. Allowed: %s", v, ignoreAllowed)
	}
	return "", fmt.Errorf("ignore \"%s\" is not a known defect code (allowed: %s)", v, ignoreAllowed)
}

// CheckIgnoreHTTP validates one ignore-http: value (a part of the URL or message): the value, or why it is refused.
func CheckIgnoreHTTP(raw string) (string, error) {
	v := strings.TrimSpace(ignoreCommentRE.ReplaceAllString(raw, ""))
	if v == "" {
		return "", errors.New(`empty ignore-http value: give the part of the URL or message to skip, e.g. "ignore-http: /static/images/"`)
	}
	if len([]rune(v)) < 3 || !alnumRE.MatchString(v) || bareHTTPRE.MatchString(v) {
		return "", fmt.Errorf("ignore-http \"%s\" is too broad (it would match almost every request): use at least 3 characters naming a path or host, e.g. \"/static/images/\"", v)
	}
	return v, nil
}

var (
	roleName     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	secretFields = regexp.MustCompile(`^(user|username|email|password|pass|passwd|token|secret|cookie|cookies|api_key|apikey)$`)
	roleFields   = []string{"login", "success", "user_field", "password_field", "submit", "user_env", "password_env", "storage_state", "login_command", "headers_env"}
	envSafe      = regexp.MustCompile(`[^A-Z0-9]+`)
)

// RoleEnv returns the env var names that hold a role's user and password.
func RoleEnv(r Role) (user, password string) {
	base := "WINGMAN_ROLE_" + envSafe.ReplaceAllString(strings.ToUpper(r.Name), "_")
	user, password = base+"_USER", base+"_PASSWORD"
	if r.UserEnv != "" {
		user = r.UserEnv
	}
	if r.PasswordEnv != "" {
		password = r.PasswordEnv
	}
	return user, password
}

func parseRoles(n *yaml.Node) (map[string]Role, []string) {
	roles := map[string]Role{}
	var probs []string
	if n.Kind != yaml.MappingNode {
		return roles, []string{"visual.roles: write a map of role names"}
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		name, body := n.Content[i].Value, n.Content[i+1]
		switch {
		case !roleName.MatchString(name):
			probs = append(probs, fmt.Sprintf("visual.roles: role name %q must be kebab-case (a-z, 0-9, -)", name))
			continue
		case name == "anonymous":
			probs = append(probs, `visual.roles: "anonymous" is built in (no login); pick another name`)
			continue
		case body.Kind != yaml.MappingNode:
			probs = append(probs, fmt.Sprintf("visual.roles.%s: write a map of fields (%s)", name, strings.Join(roleFields, ", ")))
			continue
		}
		r := Role{Name: name}
		fields := map[string]*string{"login": &r.Login, "success": &r.Success, "user_field": &r.UserField, "password_field": &r.PasswordField,
			"submit": &r.Submit, "user_env": &r.UserEnv, "password_env": &r.PasswordEnv, "storage_state": &r.StorageState,
			"login_command": &r.LoginCommand, "headers_env": &r.HeadersEnv}
		for j := 0; j+1 < len(body.Content); j += 2 {
			k, v := body.Content[j].Value, body.Content[j+1].Value
			if secretFields.MatchString(k) {
				u, p := RoleEnv(r)
				probs = append(probs, fmt.Sprintf("visual.roles.%s.%s: credentials must not be written in wingman-spec.yaml; use the env vars %s and %s, or .wingman-spec/local/roles.yaml (gitignored)", name, k, u, p))
				continue
			}
			dst, ok := fields[k]
			if !ok {
				probs = append(probs, fmt.Sprintf("visual.roles.%s.%s: unknown field (%s)", name, k, strings.Join(roleFields, ", ")))
				continue
			}
			*dst = v
		}
		if r.Login == "" && r.StorageState == "" && r.LoginCommand == "" && r.HeadersEnv == "" {
			probs = append(probs, fmt.Sprintf("visual.roles.%s: needs one of `login:` (the login page path), `storage_state:` (a recorded Playwright session file), `login_command:` (a script that writes one) or `headers_env:` (request headers from env vars)", name))
		}
		if r.HeadersEnv != "" {
			if _, err := ParseHeaders(r.HeadersEnv); err != nil {
				probs = append(probs, fmt.Sprintf("visual.roles.%s.headers_env: %v", name, err))
			}
		}
		if r.Login != "" && !strings.HasPrefix(r.Login, "/") {
			probs = append(probs, fmt.Sprintf("visual.roles.%s.login: must be a path starting with \"/\", got %q", name, r.Login))
		}
		roles[name] = r
	}
	return roles, probs
}

// Header is one request header of a role: its name and the env var that holds the value.
type Header struct{ Name, Env string }

var headerRE = regexp.MustCompile(`^([A-Za-z0-9-]+)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)$`)

// ParseHeaders reads `headers_env: Header-Name=ENV_VAR, ...`.
func ParseHeaders(v string) ([]Header, error) {
	var out []Header
	for part := range strings.SplitSeq(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		m := headerRE.FindStringSubmatch(part)
		if m == nil {
			name, _, _ := strings.Cut(part, "=")
			if strings.Contains(part, "=") {
				name += "=..."
			}
			return nil, fmt.Errorf("expected \"Header-Name=ENV_VAR\", got %q", name)
		}
		out = append(out, Header{m[1], m[2]})
	}
	return out, nil
}
