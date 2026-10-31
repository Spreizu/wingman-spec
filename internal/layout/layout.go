// Package layout finds the Wingman Spec roots of a working directory.
//
// Three layouts exist:
//
//   - next to the code: <repo>/.wingman-spec/ holds wingman-spec.yaml, specs/, changes/, archive/ and adrs/;
//   - a specs repo: the same content at the repository root, with wingman-spec.yaml at the root;
//   - a code repo linked to a specs repo: <repo>/.wingman-spec/wingman-spec.yaml says `specs: <path>`.
//
// The shim and cache (bin/, cache/) live in <code root>/.wingman-spec/; run state (runs/<change>/) lives next to the
// change in the specs root. Both are gitignored.
package layout

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Names of the files and directories that make up a layout.
const (
	Dir        = ".wingman-spec"
	ConfigFile = "wingman-spec.yaml"
	SpecsDir   = "specs"
	ChangesDir = "changes"
	ArchiveDir = "archive"
	ADRsDir    = "adrs"
	RunsDir    = "runs"
	BinDir     = "bin"
	CacheDir   = "cache"
)

// Kind tells which of the three layouts a root uses.
type Kind string

// The layouts.
const (
	InRepo    Kind = "in-repo"
	SpecsRepo Kind = "specs-repo"
	Linked    Kind = "linked"
)

// Root is a resolved layout.
type Root struct {
	Kind Kind `json:"kind"`
	// Code is the repository whose commands run and whose .wingman-spec/ holds the run state.
	Code string `json:"code"`
	// Specs is the directory with specs/, changes/, archive/ and adrs/.
	Specs string `json:"specs"`
	// Configs lists the config files, highest priority first. The last one belongs to the specs root.
	Configs []string `json:"configs"`
	// Link is the `specs:` value of a linked code repo, as written.
	Link string `json:"link,omitempty"`
	// Remote is the `specs_remote:` value of a linked code repo (credentials stripped).
	Remote string `json:"remote,omitempty"`
}

// ErrNotFound means no layout was found above the start directory.
var ErrNotFound = errors.New("no Wingman Spec root found: run `wingman-spec init` in the repository, or pass --root <specs dir>")

// MissingSpecsError is returned when a linked code repo points at a specs directory that does not exist.
type MissingSpecsError struct {
	Code, Link, Dir, Remote string
}

func (e *MissingSpecsError) Error() string {
	url := e.Remote
	if url == "" {
		url = "<specs repo url>"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "the specs repo is missing: %s\n", e.Dir)
	fmt.Fprintf(&b, "  %s says `specs: %s` (relative to %s).\n", filepath.Join(Dir, ConfigFile), e.Link, e.Code)
	fmt.Fprintf(&b, "  Clone it there; nothing is cloned for you:\n    git clone %s %s\n", url, e.Dir)
	if e.Remote == "" {
		b.WriteString("  (ask whoever set it up for the URL, or add `specs_remote: <url>` to the config)\n")
	}
	b.WriteString("  Or, for one run, pass --root <dir> of a clone you already have.")
	return b.String()
}

// Find resolves the layout for start (a directory). override, when not empty, is a specs root given by
// --root or WINGMAN_SPEC_ROOT; the code root is then still searched from start.
func Find(start, override string) (*Root, error) {
	start, err := filepath.Abs(start)
	if err != nil {
		return nil, err
	}
	if override != "" {
		return fromOverride(start, override)
	}
	for dir := start; ; dir = filepath.Dir(dir) {
		r, err := at(dir)
		if r != nil || err != nil {
			return r, err
		}
		if filepath.Dir(dir) == dir {
			return nil, ErrNotFound
		}
	}
}

// at returns the layout rooted exactly at dir, or nil.
func at(dir string) (*Root, error) {
	inner := filepath.Join(dir, Dir, ConfigFile)
	if isFile(inner) {
		link, remote, err := linkOf(inner)
		if err != nil {
			return nil, err
		}
		if link == "" {
			return &Root{Kind: InRepo, Code: dir, Specs: filepath.Join(dir, Dir), Configs: []string{inner}}, nil
		}
		specs := filepath.Clean(filepath.Join(dir, link))
		if !isDir(specs) {
			return nil, &MissingSpecsError{Code: dir, Link: link, Dir: specs, Remote: remote}
		}
		r := &Root{Kind: Linked, Code: dir, Specs: specs, Link: link, Remote: remote, Configs: []string{inner}}
		if c := filepath.Join(specs, ConfigFile); isFile(c) {
			r.Configs = append(r.Configs, c)
		}
		return r, nil
	}
	if outer := filepath.Join(dir, ConfigFile); isFile(outer) {
		return &Root{Kind: SpecsRepo, Code: dir, Specs: dir, Configs: []string{outer}}, nil
	}
	return nil, nil
}

func fromOverride(start, override string) (*Root, error) {
	specs, err := filepath.Abs(override)
	if err != nil {
		return nil, err
	}
	if !isDir(specs) {
		return nil, fmt.Errorf("--root %s: not a directory", override)
	}
	// --root may name either the specs directory or a repo that holds .wingman-spec/.
	if isFile(filepath.Join(specs, Dir, ConfigFile)) && !isDir(filepath.Join(specs, SpecsDir)) {
		specs = filepath.Join(specs, Dir)
	}
	r := &Root{Kind: SpecsRepo, Code: specs, Specs: specs}
	for dir := start; ; dir = filepath.Dir(dir) {
		if c := filepath.Join(dir, Dir, ConfigFile); isFile(c) {
			r.Code, r.Kind, r.Configs = dir, Linked, []string{c}
			if filepath.Join(dir, Dir) == specs {
				r.Kind = InRepo
			}
			break
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	if c := filepath.Join(specs, ConfigFile); isFile(c) && !slices.Contains(r.Configs, c) {
		r.Configs = append(r.Configs, c)
	}
	return r, nil
}

// Changes returns the directory of active changes.
func (r *Root) Changes() string { return filepath.Join(r.Specs, ChangesDir) }

// Change returns the directory of one change.
func (r *Root) Change(name string) string { return filepath.Join(r.Specs, ChangesDir, name) }

// LivingSpecs returns the directory of the living specs.
func (r *Root) LivingSpecs() string { return filepath.Join(r.Specs, SpecsDir) }

// Archive returns the archive directory.
func (r *Root) Archive() string { return filepath.Join(r.Specs, ArchiveDir) }

// ADRs returns the promoted ADR directory.
func (r *Root) ADRs() string { return filepath.Join(r.Specs, ADRsDir) }

// State returns the code root's .wingman-spec directory (runs, bin, cache).
func (r *Root) State() string { return filepath.Join(r.Code, Dir) }

// Runs returns the run-state directory of a change. It sits next to the change's tasks.md (in the specs root), so every code
// worktree that shares a specs repository sees the same open run and cannot tick the same tasks twice.
func (r *Root) Runs(change string) string { return filepath.Join(r.Specs, RunsDir, change) }

// Rel returns p relative to the code root when it is inside it, else p.
func (r *Root) Rel(p string) string {
	if rel, err := filepath.Rel(r.Code, p); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return p
}

// linkOf reads the `specs:` and `specs_remote:` values of a code repo config without a full parse,
// so a broken config elsewhere does not hide the layout.
func linkOf(file string) (link, remote string, err error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return "", "", err
	}
	for line := range strings.Lines(string(b)) {
		if v, ok := topValue(line, "specs"); ok {
			link = v
		}
		if v, ok := topValue(line, "specs_remote"); ok {
			remote = CleanURL(v)
		}
	}
	return link, remote, nil
}

// topValue returns the scalar of a top-level `key: value` line (quotes and a trailing comment removed).
func topValue(line, key string) (string, bool) {
	rest, ok := strings.CutPrefix(line, key+":")
	if !ok {
		return "", false
	}
	v := strings.TrimSpace(rest)
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	if strings.HasPrefix(v, "#") {
		v = ""
	}
	return strings.Trim(v, `"'`), true
}

// CleanURL removes user:password@ from a URL so it can be printed.
func CleanURL(u string) string {
	scheme, rest, ok := strings.Cut(u, "://")
	if !ok {
		return u
	}
	if at := strings.Index(rest, "@"); at >= 0 && !strings.Contains(rest[:at], "/") {
		rest = rest[at+1:]
	}
	return scheme + "://" + rest
}

func isFile(p string) bool { st, err := os.Stat(p); return err == nil && st.Mode().IsRegular() }
func isDir(p string) bool  { st, err := os.Stat(p); return err == nil && st.IsDir() }
