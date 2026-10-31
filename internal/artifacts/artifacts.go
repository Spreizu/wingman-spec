// Package artifacts holds the embedded planning artifacts (app-map, proposal, specs, design, adrs, tasks): their
// templates, instructions and order, and reports which ones a change has written.
package artifacts

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

//go:embed artifacts.yaml templates/*.md
var files embed.FS

// Artifact is one planning document of a change.
type Artifact struct {
	ID          string   `yaml:"id" json:"id"`
	Generates   string   `yaml:"generates" json:"generates"`
	Description string   `yaml:"description" json:"description"`
	Template    string   `yaml:"template" json:"template"`
	Instruction string   `yaml:"instruction" json:"instruction"`
	Requires    []string `yaml:"requires" json:"requires"`
}

// Set is every artifact plus the apply instruction.
type Set struct {
	Name        string     `yaml:"name"`
	Version     int        `yaml:"version"`
	Description string     `yaml:"description"`
	Artifacts   []Artifact `yaml:"artifacts"`
	Apply       struct {
		Requires    []string `yaml:"requires"`
		Tracks      string   `yaml:"tracks"`
		Instruction string   `yaml:"instruction"`
	} `yaml:"apply"`
}

// Load parses the embedded artifacts.yaml.
func Load() (*Set, error) {
	b, err := files.ReadFile("artifacts.yaml")
	if err != nil {
		return nil, err
	}
	var s Set
	if err := yaml.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("artifacts.yaml: %w", err)
	}
	return &s, nil
}

// MustLoad is Load for the embedded file, which the tests prove valid.
func MustLoad() *Set {
	s, err := Load()
	if err != nil {
		panic(err)
	}
	return s
}

// Get returns the artifact with the id.
func (s *Set) Get(id string) (Artifact, bool) {
	i := slices.IndexFunc(s.Artifacts, func(a Artifact) bool { return a.ID == id })
	if i < 0 {
		return Artifact{}, false
	}
	return s.Artifacts[i], true
}

// IDs lists the artifact ids in order.
func (s *Set) IDs() []string {
	ids := make([]string, len(s.Artifacts))
	for i, a := range s.Artifacts {
		ids[i] = a.ID
	}
	return ids
}

// Template returns the template text of a file name (e.g. "proposal.md").
func Template(name string) (string, error) {
	b, err := files.ReadFile("templates/" + name)
	return string(b), err
}

// State of an artifact in a change.
const (
	Done    = "done"
	Ready   = "ready"
	Blocked = "blocked"
)

// ArtifactStatus is one row of Status.
type ArtifactStatus struct {
	ID          string   `json:"id"`
	OutputPath  string   `json:"outputPath"`
	Status      string   `json:"status"`
	MissingDeps []string `json:"missingDeps,omitempty"`
}

// ChangeStatus reports which artifacts a change has.
type ChangeStatus struct {
	Change     string           `json:"changeName"`
	IsComplete bool             `json:"isComplete"`
	Artifacts  []ArtifactStatus `json:"artifacts"`
}

// Exists reports whether the change dir has output for the pattern (a file name or a glob such as "specs/**/*.md").
func Exists(changeDir, pattern string) bool {
	if !strings.ContainsAny(pattern, "*?[") {
		st, err := os.Stat(filepath.Join(changeDir, pattern))
		return err == nil && st.Mode().IsRegular()
	}
	dir, _, _ := strings.Cut(pattern, "/")
	found := false
	_ = filepath.WalkDir(filepath.Join(changeDir, dir), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".md") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// Status reports done/ready/blocked per artifact. skipSpecs marks specs done for a `Specs: none` change.
func (s *Set) Status(changeDir string, skipSpecs bool) ChangeStatus {
	cs := ChangeStatus{Change: filepath.Base(changeDir), IsComplete: true}
	done := map[string]bool{}
	for _, a := range s.Artifacts {
		done[a.ID] = Exists(changeDir, a.Generates) || (a.ID == "specs" && skipSpecs)
	}
	for _, a := range s.Artifacts {
		st := ArtifactStatus{ID: a.ID, OutputPath: a.Generates, Status: Done}
		if !done[a.ID] {
			cs.IsComplete = false
			st.Status = Ready
			for _, r := range a.Requires {
				if !done[r] {
					st.MissingDeps = append(st.MissingDeps, r)
				}
			}
			if len(st.MissingDeps) > 0 {
				st.Status = Blocked
			}
		}
		cs.Artifacts = append(cs.Artifacts, st)
	}
	return cs
}
