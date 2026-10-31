// Package detect reads a code repository's own commands (test, typecheck, lint) and how to start its UI, for the
// config `wingman-spec init` writes. Empty means not detected: the <fill in> placeholder stays.
package detect

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Result is what was detected. Visual is "off" (no UI), "" (a UI that cannot be started automatically) or set
// together with URL.
type Result struct {
	Test      string `json:"test"`
	Typecheck string `json:"typecheck"`
	Lint      string `json:"lint"`
	Visual    string `json:"visual"`
	URL       string `json:"url"`
	// Notes explain a detected command that was dropped because it does not run here.
	Notes []string `json:"notes"`
}

type repo struct {
	dir     string
	scripts map[string]string
	deps    map[string]bool
	all     string // every script joined
}

func load(dir string) *repo {
	r := &repo{dir: dir, scripts: map[string]string{}, deps: map[string]bool{}}
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return r
	}
	var p struct {
		Scripts         map[string]string `json:"scripts"`
		Dependencies    map[string]any    `json:"dependencies"`
		DevDependencies map[string]any    `json:"devDependencies"`
	}
	if json.Unmarshal(b, &p) != nil {
		return r
	}
	var all []string
	for k, v := range p.Scripts {
		r.scripts[k] = v
		all = append(all, v)
	}
	r.all = strings.Join(all, " ")
	for k := range p.Dependencies {
		r.deps[k] = true
	}
	for k := range p.DevDependencies {
		r.deps[k] = true
	}
	return r
}

func (r *repo) script(n string) bool {
	s, ok := r.scripts[n]
	return ok && s != "" && !strings.Contains(s, "no test specified")
}

// dep: listed in package.json, or run by one of its scripts.
func (r *repo) dep(n string) bool {
	if r.deps[n] {
		return true
	}
	return regexp.MustCompile(`(^|[\s&;|(])` + regexp.QuoteMeta(n) + `(\s|$)`).MatchString(r.all)
}

func (r *repo) has(names ...string) bool {
	for _, n := range names {
		if ms, _ := filepath.Glob(filepath.Join(r.dir, n)); len(ms) > 0 {
			return true
		}
	}
	return false
}

func (r *repo) grep(re string, files ...string) bool {
	x := regexp.MustCompile("(?m)" + re)
	for _, f := range files {
		if b, err := os.ReadFile(filepath.Join(r.dir, f)); err == nil && x.Match(b) {
			return true
		}
	}
	return false
}

func (r *repo) pm() string {
	switch {
	case r.has("pnpm-lock.yaml"):
		return "pnpm"
	case r.has("yarn.lock"):
		return "yarn"
	}
	return "npm"
}

func (r *repo) run() string {
	if p := r.pm(); p != "npm" {
		return p
	}
	return "npm run"
}

func (r *repo) test() string {
	switch {
	case r.script("test"):
		return r.pm() + " test"
	case r.has("pytest.ini", "conftest.py") || r.grep(`^\[tool\.pytest`, "pyproject.toml") || r.grep(`^\[tool:pytest\]`, "setup.cfg"):
		return "python3 -m pytest"
	case r.has("tests/test_*.py"):
		return "python3 -m unittest discover -s tests -t ."
	case r.has("go.mod"):
		return "go test ./..."
	case r.has("Cargo.toml"):
		return "cargo test"
	case r.grep(`^test:`, "Makefile"):
		return "make test"
	}
	return ""
}

func (r *repo) typecheck() string {
	for _, s := range []string{"typecheck", "type-check", "typecheck:all", "check-types", "types", "tsc"} {
		if r.script(s) {
			return r.run() + " " + s
		}
	}
	// --incremental: a check after a small edit re-reads only what changed; the build info stays in node_modules/.cache
	inc := "--incremental --tsBuildInfoFile node_modules/.cache/wingman-spec/tsc.tsbuildinfo"
	switch {
	case r.dep("vue-tsc") && r.has("tsconfig.json"):
		return "npx vue-tsc --noEmit " + inc
	case r.dep("typescript") && r.has("tsconfig.json"):
		return "npx tsc --noEmit " + inc
	case r.has("mypy.ini", ".mypy.ini") || r.grep(`^\[tool\.mypy\]`, "pyproject.toml") || r.grep(`^\[mypy\]`, "setup.cfg"):
		// mypy's own `files =` setting decides what to check; `mypy .` would override it
		if r.grep(`^\s*files\s*=`, "mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg") {
			return "python3 -m mypy"
		}
		return "python3 -m mypy ."
	case r.has("pyrightconfig.json") || r.grep(`^\[tool\.pyright\]`, "pyproject.toml"):
		return "pyright"
	case r.has("go.mod"):
		return "go vet ./..."
	}
	return ""
}

func (r *repo) lint() string {
	switch {
	case r.script("lint"):
		return r.run() + " lint"
	case r.dep("eslint") && r.has("eslint.config.*", ".eslintrc*"):
		return "npx eslint --cache --cache-location node_modules/.cache/wingman-spec/eslint ."
	case r.dep("@biomejs/biome") && r.has("biome.json*"):
		return "npx biome lint ."
	case r.has("ruff.toml", ".ruff.toml") || r.grep(`^\[tool\.ruff`, "pyproject.toml"):
		return "ruff check ."
	case r.has(".flake8") || r.grep(`^\[flake8\]`, "setup.cfg", "tox.ini"):
		return "python3 -m flake8"
	case r.has(".golangci.yml", ".golangci.yaml"):
		return "golangci-lint run"
	}
	return ""
}

func (r *repo) visual() (string, string) {
	p := r.run()
	switch {
	case r.dep("vite") && r.script("build") && r.script("preview"):
		return p + " build && " + p + " preview -- --port 4173 --strictPort --host 127.0.0.1", "http://127.0.0.1:4173/"
	case r.dep("next") && r.script("build") && r.script("start"):
		return p + " build && " + p + " start -- -p 3000 -H 127.0.0.1", "http://127.0.0.1:3000/"
	}
	if slices.ContainsFunc([]string{"vite", "next", "react", "vue", "svelte", "@angular/core", "astro"}, r.dep) {
		return "", ""
	}
	if r.has("index.html", "src/*.vue", "src/*.tsx", "src/*.jsx") {
		return "", ""
	}
	return "off", ""
}

// Detect reads dir. With probe, a detected typecheck or lint command runs once (up to 5 minutes): one that is not
// installed or already fails would fail every task's check, so it is dropped with a note. Env
// WINGMAN_SPEC_INIT_PROBE=0 skips the run.
func Detect(dir string, probe bool) Result {
	r := load(dir)
	res := Result{Test: r.test(), Typecheck: r.typecheck(), Lint: r.lint()}
	res.Visual, res.URL = r.visual()
	if probe && os.Getenv("WINGMAN_SPEC_INIT_PROBE") != "0" {
		for _, c := range []*string{&res.Typecheck, &res.Lint} {
			if *c == "" {
				continue
			}
			if note := Probe(dir, *c); note != "" {
				res.Notes = append(res.Notes, note)
				*c = ""
			}
		}
	}
	return res
}

var missingRE = regexp.MustCompile(`No module named|command not found|could not determine executable|is not recognized`)

// Probe runs cmd in dir and returns why it cannot be configured ("" when it passes).
func Probe(dir, cmd string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "cmd", "/C", cmd)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", cmd)
	}
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err == nil {
		return ""
	}
	code := -1
	if ee, ok := errors.AsType[*exec.ExitError](err); ok {
		code = ee.ExitCode()
	}
	if code == 127 || missingRE.Match(out) {
		return "detected `" + cmd + "` but it is not installed here"
	}
	return "detected `" + cmd + "` but it fails on the current code (exit " + strconv.Itoa(code) + ")"
}
