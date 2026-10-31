// Package scaffold writes the files `wingman-spec init` creates.
package scaffold

import (
	"bytes"
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
	"text/template"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

//go:embed wingman-spec.yaml.tmpl
var configTemplate string

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

// Config renders the wingman-spec.yaml for a layout.
func Config(o Options) (string, error) {
	t, err := template.New("cfg").Funcs(template.FuncMap{"q": q}).Parse(configTemplate)
	if err != nil {
		return "", err
	}
	var b bytes.Buffer
	err = t.Execute(&b, map[string]any{"Specs": o.SpecsPath, "SpecsRemote": o.SpecsRemote, "Linked": o.Layout == Link, "SpecsRepo": o.Layout == Specs,
		"Test": o.Test, "Typecheck": o.Typecheck, "Lint": o.Lint, "Visual": o.Visual, "URL": o.URL})
	return b.String(), err
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
