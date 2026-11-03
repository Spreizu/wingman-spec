// Package scaffold writes the files `wingman-spec init` creates.
package scaffold

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

//go:embed wingman-spec.yaml.sections
var configSections string

// Gitignore is .wingman-spec/.gitignore next to code: the local run state.
const Gitignore = "runs/\nbin/\ncache/\nlocal/\n"

// Layout names accepted by init.
const (
	Repo  = "repo"  // specs next to the code, in .wingman-spec/
	Specs = "specs" // a separate specs repository: specs at its root
	Link  = "link"  // a code repository whose specs live in a specs repository
)

// Options of Init.
type Options struct {
	Layout      string
	SpecsPath   string // Link: the specs repo, relative to dir
	SpecsRemote string
	// Detected commands (empty: the <fill in> placeholder); Visual "off" writes `visual: off`.
	Test, Typecheck, Lint, Visual, URL string
}

// q writes a command as a YAML scalar: plain when that reads back the same, else double-quoted.
func q(s string) string {
	if s == "" {
		return "<fill in>"
	}
	if strings.ContainsAny(s[:1], "!&*?|>'\"%@`{}[],#-:") || strings.Contains(s, ": ") || strings.Contains(s, " #") || strings.TrimSpace(s) != s {
		b, _ := json.Marshal(s)
		return string(b)
	}
	return s
}

// sections are the named parts of configSections, each ending in a newline.
func sections() map[string]string {
	m := map[string]string{}
	for part := range strings.SplitSeq(configSections, "\n@@ ") {
		name, body, _ := strings.Cut(part, "\n")
		m[name] = strings.TrimSuffix(body, "\n") + "\n"
	}
	return m
}

// Config renders the wingman-spec.yaml for a layout: blocks set apart by a blank line, the visual block with its
// command or placeholders, and the specs-repository and linked-repository parts only where they apply.
func Config(o Options) (string, error) {
	sec, linked := sections(), o.Layout == Link
	fill := strings.NewReplacer("<<specs>>", o.SpecsPath, "<<specs-remote>>", o.SpecsRemote, "<<test>>", q(o.Test),
		"<<typecheck>>", q(o.Typecheck), "<<lint>>", q(o.Lint), "<<visual>>", q(o.Visual), "<<url>>", o.URL)
	b := []string{sec["header"]}
	add := func(blank bool, names ...string) {
		for _, n := range names {
			if blank {
				b = append(b, "\n")
				blank = false
			}
			b = append(b, fill.Replace(sec[n]))
		}
	}
	if o.SpecsPath != "" {
		add(true, "specs")
		if o.SpecsRemote != "" {
			add(false, "specs-remote")
		}
	}
	if !linked {
		add(true, "context")
	}
	add(true, "commands")
	if !linked {
		add(true, "traceability")
	}
	add(true, "visual")
	switch o.Visual {
	case "off":
		add(false, "visual-off")
	case "":
		add(false, "visual-on", "visual-fill", "visual-options")
	default:
		add(false, "visual-on", "visual-command", "visual-options")
	}
	if o.Layout == Specs {
		add(true, "repos")
	}
	return strings.Join(b, ""), nil
}

// Init creates the skeleton in dir and returns the files it wrote (existing files are kept).
func Init(dir string, o Options) ([]string, error) {
	var files map[string]string
	cfg, err := Config(o)
	if err != nil {
		return nil, err
	}
	keep := "" // an empty folder git keeps
	switch o.Layout {
	case Repo, "":
		files = map[string]string{
			filepath.Join(layout.Dir, layout.ConfigFile):             cfg,
			filepath.Join(layout.Dir, ".gitignore"):                  Gitignore,
			filepath.Join(layout.Dir, layout.SpecsDir, ".gitkeep"):   keep,
			filepath.Join(layout.Dir, layout.ChangesDir, ".gitkeep"): keep,
		}
	case Specs:
		files = map[string]string{
			layout.ConfigFile:                            cfg,
			filepath.Join(layout.Dir, ".gitignore"):      "*\n",
			filepath.Join(layout.RunsDir, ".gitignore"):  "*\n", // run state sits in the specs root here; the folder ignores itself
			filepath.Join(layout.SpecsDir, ".gitkeep"):   keep,
			filepath.Join(layout.ChangesDir, ".gitkeep"): keep,
		}
	case Link:
		if o.SpecsPath == "" {
			return nil, errors.New("--layout link needs --specs <path to the specs repository>")
		}
		if _, err := os.Stat(filepath.Join(dir, o.SpecsPath, layout.ConfigFile)); err != nil {
			return nil, fmt.Errorf("%s has no %s: run `wingman-spec init --layout specs` there first", o.SpecsPath, layout.ConfigFile)
		}
		files = map[string]string{
			filepath.Join(layout.Dir, layout.ConfigFile): cfg,
			filepath.Join(layout.Dir, ".gitignore"):      Gitignore,
		}
	default:
		return nil, fmt.Errorf("--layout %q: use repo, specs or link", o.Layout)
	}
	var wrote []string
	for _, name := range slices.Sorted(maps.Keys(files)) {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(p, []byte(files[name]), 0o644); err != nil {
			return nil, err
		}
		wrote = append(wrote, filepath.ToSlash(name))
	}
	return wrote, nil
}
