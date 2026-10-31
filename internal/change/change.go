// Package change creates, lists, syncs and archives changes.
package change

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/adr"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/validate"
)

var nameRE = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ErrNoChange is returned for a change folder that does not exist.
var ErrNoChange = errors.New("no such change")

// CheckName validates a change name (kebab-case).
func CheckName(name string) error {
	if !nameRE.MatchString(name) || name == "archive" {
		return fmt.Errorf("change name %q: use kebab-case (a-z, 0-9 and single dashes), e.g. add-search", name)
	}
	return nil
}

// Dir returns the change folder, or ErrNoChange.
func Dir(r *layout.Root, name string) (string, error) {
	if err := CheckName(name); err != nil {
		return "", err
	}
	d := r.Change(name)
	if st, err := os.Stat(d); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%w %q in %s", ErrNoChange, name, r.Rel(r.Changes()))
	}
	return d, nil
}

// New creates an empty change folder.
func New(r *layout.Root, name string) (string, error) {
	if err := CheckName(name); err != nil {
		return "", err
	}
	d := r.Change(name)
	if _, err := os.Stat(d); err == nil {
		return "", fmt.Errorf("change %q already exists (%s)", name, r.Rel(d))
	}
	return d, os.MkdirAll(d, 0o755)
}

// Summary is one row of List.
type Summary struct {
	Name           string    `json:"name"`
	CompletedTasks int       `json:"completedTasks"`
	TotalTasks     int       `json:"totalTasks"`
	LastModified   time.Time `json:"lastModified"`
	Status         string    `json:"status"` // no-tasks, in-progress, complete
}

// List returns the active changes sorted by name.
func List(r *layout.Root) ([]Summary, error) {
	ents, err := os.ReadDir(r.Changes())
	if errors.Is(err, fs.ErrNotExist) {
		return []Summary{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Summary{}
	for _, e := range ents {
		if !e.IsDir() || e.Name() == layout.ArchiveDir || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(r.Changes(), e.Name())
		s := Summary{Name: e.Name(), Status: "no-tasks", LastModified: newest(dir)}
		if b, err := os.ReadFile(filepath.Join(dir, "tasks.md")); err == nil {
			for _, t := range tasks.Parse(string(b)).All() {
				s.TotalTasks++
				if t.Done {
					s.CompletedTasks++
				}
			}
			s.Status = "in-progress"
			if s.TotalTasks > 0 && s.CompletedTasks == s.TotalTasks {
				s.Status = "complete"
			}
		}
		out = append(out, s)
	}
	return out, nil
}

func newest(dir string) time.Time {
	var t time.Time
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().After(t) {
			t = info.ModTime()
		}
		return nil
	})
	return t.UTC().Truncate(time.Second)
}

// Capability is what Sync did with one delta spec.
type Capability struct {
	Name   string `json:"name"`
	Action string `json:"action"` // created, updated, unchanged
}

// SyncResult is the outcome of Sync.
type SyncResult struct {
	Change       string       `json:"change"`
	Capabilities []Capability `json:"capabilities"`
	ADRs         []adr.Result `json:"adrs"`
	Problems     []string     `json:"problems"`
}

// Sync merges every delta spec of the change into the living specs and promotes its ADRs. Nothing is written when a
// delta conflicts. With dryRun nothing is written at all.
func Sync(r *layout.Root, name string, dryRun bool) (*SyncResult, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	res := &SyncResult{Change: name, Capabilities: []Capability{}, ADRs: []adr.Result{}, Problems: []string{}}
	deltas, err := filepath.Glob(filepath.Join(dir, "specs", "*.md"))
	if err != nil {
		return nil, err
	}
	type write struct{ path, text string }
	var writes []write
	for _, p := range deltas {
		capability := strings.TrimSuffix(filepath.Base(p), ".md")
		db, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		target := filepath.Join(r.LivingSpecs(), capability+".md")
		old, err := os.ReadFile(target)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		d := spec.ParseDelta(string(db))
		if len(spec.Synced(string(old), d)) == 0 && len(d.Problems) == 0 && len(old) > 0 {
			res.Capabilities = append(res.Capabilities, Capability{capability, "unchanged"})
			continue
		}
		merged, err := spec.Merge(capability, string(old), d)
		if err != nil {
			me, ok := errors.AsType[*spec.MergeError](err)
			if !ok {
				return nil, err
			}
			for _, pr := range me.Problems {
				res.Problems = append(res.Problems, fmt.Sprintf("%s:%d: %s", r.Rel(p), pr.Line, pr.Msg))
			}
			continue
		}
		action := "updated"
		if len(old) == 0 {
			action = "created"
		}
		res.Capabilities = append(res.Capabilities, Capability{capability, action})
		writes = append(writes, write{target, merged})
	}
	if len(res.Problems) > 0 {
		return res, nil
	}
	if !dryRun {
		if len(writes) > 0 {
			if err := os.MkdirAll(r.LivingSpecs(), 0o755); err != nil {
				return nil, err
			}
		}
		for _, w := range writes {
			if err := os.WriteFile(w.path, []byte(w.text), 0o644); err != nil {
				return nil, err
			}
		}
	}
	adrs, err := adr.Promote(dir, name, r.ADRs(), dryRun)
	if err != nil {
		res.Problems = append(res.Problems, err.Error())
		return res, nil
	}
	if adrs != nil {
		res.ADRs = adrs
	}
	return res, nil
}

// SyncCheck lists what of the change is not merged into the living specs or promoted to adrs/. It writes nothing.
func SyncCheck(r *layout.Root, name string) ([]string, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	probs := []string{}
	deltas, _ := filepath.Glob(filepath.Join(dir, "specs", "*.md"))
	for _, p := range deltas {
		capability := strings.TrimSuffix(filepath.Base(p), ".md")
		db, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		old, _ := os.ReadFile(filepath.Join(r.LivingSpecs(), capability+".md"))
		for _, pr := range spec.Synced(string(old), spec.ParseDelta(string(db))) {
			probs = append(probs, fmt.Sprintf("specs: %s:%d: %s", r.Rel(p), pr.Line, pr.Msg))
		}
	}
	ap, err := adr.Check(dir, name, r.ADRs())
	if err != nil {
		return nil, err
	}
	for _, p := range ap {
		probs = append(probs, "adrs: "+p)
	}
	return probs, nil
}

// Refused is an archive that cannot happen yet.
type Refused struct {
	Reason   string   `json:"problem"`
	Tasks    []string `json:"tasks,omitempty"`
	Problems []string `json:"problems,omitempty"`
	Blocked  bool     `json:"-"`
}

func (e *Refused) Error() string { return e.Reason }

// ArchiveName is the archive folder of a change archived at t: YYYY-MM-DD-HHMM-<change>.
func ArchiveName(name string, t time.Time) string { return t.Format("2006-01-02-1504") + "-" + name }

// Archive moves a finished, synced change to archive/YYYY-MM-DD-HHMM-<change> and returns the new folder.
func Archive(r *layout.Root, name string, now time.Time) (string, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dir, "BLOCKED.md")); err == nil {
		return "", &Refused{Reason: "BLOCKED.md exists: run /spec-fix first", Blocked: true}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "tasks.md")); err == nil {
		var open []string
		for _, t := range tasks.Parse(string(b)).All() {
			if !t.Done {
				open = append(open, strings.TrimSpace(t.Label+" "+t.Title))
			}
		}
		if len(open) > 0 {
			return "", &Refused{Reason: fmt.Sprintf("%d task(s) are not done: finish /spec-apply (or /spec-fix) first", len(open)), Tasks: open}
		}
	}
	probs, err := SyncCheck(r, name)
	if err != nil {
		return "", err
	}
	if len(probs) > 0 {
		return "", &Refused{Reason: fmt.Sprintf("change %q is not synced: run `wingman-spec sync %s` first", name, name), Problems: probs}
	}
	dst := filepath.Join(r.Archive(), ArchiveName(name, now))
	if _, err := os.Stat(dst); err == nil {
		return "", fmt.Errorf("%s already exists", r.Rel(dst))
	}
	if err := os.MkdirAll(r.Archive(), 0o755); err != nil {
		return "", err
	}
	return dst, os.Rename(dir, dst)
}

// Validate validates the change against the living specs.
func Validate(r *layout.Root, name string) (*validate.Report, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	return validate.Change(dir, r.LivingSpecs(), r.Rel)
}

// Archived lists the archive folders, oldest first.
func Archived(r *layout.Root) ([]string, error) {
	ents, err := os.ReadDir(r.Archive())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	slices.Sort(out)
	return out, err
}
