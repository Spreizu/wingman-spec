// Package config reads wingman-spec.yaml. Several files can apply (a code repo's own file first, then the specs
// root's); each key is taken from the first file that sets it, and `commands:` and `visual:` are merged per key.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
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
	TestFiles       []string            `yaml:"test_files" json:"test_files,omitempty"`
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
	TestOne    string `yaml:"test_one" json:"test_one,omitempty"`
	TestRun    string `yaml:"test_run" json:"test_run,omitempty"`
	CheckLevel string `yaml:"check_level" json:"check_level,omitempty"`
	JUnit      string `yaml:"junit" json:"junit,omitempty"`
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
	"anchor_stale": true, "test_files": true, "parallel": true, "visual": true, "rules": true, "specs": true, "specs_remote": true, "repos": true,
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
	case "test_files":
		return n.Decode(&c.TestFiles)
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
		return errors.New("write a map: test, typecheck, lint, targeted, test_one, test_run, check_level, junit")
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
	set("test_one", &c.Commands.TestOne, cmds.TestOne)
	if cmds.TestRun != "" && cmds.TestRun != "finish" {
		return fmt.Errorf("commands.test_run %q: the only value is finish", cmds.TestRun)
	}
	set("test_run", &c.Commands.TestRun, cmds.TestRun)
	if cmds.CheckLevel != "" && !slices.Contains(checkLevels, cmds.CheckLevel) {
		return fmt.Errorf("commands.check_level %q is not one of %s", cmds.CheckLevel, strings.Join(checkLevels, ", "))
	}
	set("check_level", &c.Commands.CheckLevel, cmds.CheckLevel)
	set("junit", &c.Commands.JUnit, cmds.JUnit)
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
