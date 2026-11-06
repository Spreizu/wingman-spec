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

// MergeResult is the living spec of every capability the change has a delta for, as archive will write it.
type MergeResult struct {
	Specs        map[string]string // capability -> merged living spec text
	Capabilities []Capability
	Problems     []string // merge conflicts: nothing of the change can be merged while there is one
	Failed       []string // the capabilities whose delta does not merge
}

// Merged merges every delta spec of the change folder dir into the living specs in memory, with the bases recorded in
// spec-base.json (see spec.Merge), exactly as archive does. With pin the bases of new deltas are recorded on disk.
func Merged(r *layout.Root, dir string, pin bool) (*MergeResult, error) {
	res := &MergeResult{Specs: map[string]string{}}
	deltas, err := filepath.Glob(filepath.Join(dir, "specs", "*.md"))
	if err != nil {
		return nil, err
	}
	bases, _, err := spec.PinBases(dir, r.LivingSpecs(), false, pin)
	if err != nil {
		res.Problems = append(res.Problems, fmt.Sprintf("%s: %s: fix or delete it, then run `wingman-spec sync %s --rebase`", r.Rel(filepath.Join(dir, spec.BaseFile)), err, filepath.Base(dir)))
		return res, nil
	}
	for _, p := range deltas {
		capability := strings.TrimSuffix(filepath.Base(p), ".md")
		db, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		old, err := os.ReadFile(filepath.Join(r.LivingSpecs(), capability+".md"))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		base := bases[capability]
		merged, err := spec.Merge(capability, string(old), spec.ParseDelta(string(db)), &base)
		if err != nil {
			me, ok := errors.AsType[*spec.MergeError](err)
			if !ok {
				return nil, err
			}
			for _, pr := range me.Problems {
				res.Problems = append(res.Problems, fmt.Sprintf("%s:%d: %s", r.Rel(p), pr.Line, pr.Msg))
			}
			res.Failed = append(res.Failed, capability)
			continue
		}
		action := "updated"
		switch {
		case merged == string(old):
			action = "unchanged"
		case len(old) == 0:
			action = "created"
		}
		res.Specs[capability] = merged
		res.Capabilities = append(res.Capabilities, Capability{capability, action})
	}
	return res, nil
}

// Sync merges every delta spec of the change into the living specs (see Merged) and promotes its ADRs. Every merge is
// computed and checked in memory first; nothing is written when one delta conflicts, and the living specs are written
// all at once. With dryRun nothing is written at all.
func Sync(r *layout.Root, name string, dryRun bool) (*SyncResult, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	res := &SyncResult{Change: name, Capabilities: []Capability{}, ADRs: []adr.Result{}, Problems: []string{}}
	m, err := Merged(r, dir, !dryRun)
	if err != nil {
		return nil, err
	}
	res.Problems = append(res.Problems, m.Problems...)
	if len(res.Problems) > 0 {
		return res, nil
	}
	writes := map[string][]byte{}
	for _, c := range m.Capabilities {
		res.Capabilities = append(res.Capabilities, c)
		if c.Action != "unchanged" {
			writes[filepath.Join(r.LivingSpecs(), c.Name+".md")] = []byte(m.Specs[c.Name])
		}
	}
	if !dryRun && len(writes) > 0 {
		if err := spec.WriteAtomic(writes); err != nil {
			return nil, err
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

// Rebase records the base of every delta spec of the change again from the living specs as they are now (after the
// delta was updated for what another change merged) and returns the requirements whose base moved.
func Rebase(r *layout.Root, name string) ([]string, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	_, moved, err := spec.PinBases(dir, r.LivingSpecs(), true, true)
	if moved == nil {
		moved = []string{}
	}
	return moved, err
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

// ArchiveName is the archive folder of a change archived at t: YYYY-MM-DD-HHMM-<change>.
func ArchiveName(name string, t time.Time) string { return t.Format("2006-01-02-1504") + "-" + name }

// archivePrefix is the date, and the optional HHMM, that ArchiveName writes before the change name.
var archivePrefix = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-(?:\d{4}-)?`)

// NameOf is the change name stored in an archive folder.
func NameOf(folder string) string { return archivePrefix.ReplaceAllString(folder, "") }

// Archive moves a change to archive/YYYY-MM-DD-HHMM-<change> and returns the new folder. The checks that come first
// are verify's archive gate.
func Archive(r *layout.Root, name string, now time.Time) (string, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return "", err
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

// Validate validates the change against the living specs, recording the base of a delta spec seen for the first time
// (see spec.PinBases).
func Validate(r *layout.Root, name string) (*validate.Report, error) {
	dir, err := Dir(r, name)
	if err != nil {
		return nil, err
	}
	if _, _, err := spec.PinBases(dir, r.LivingSpecs(), false, true); err != nil && !strings.Contains(err.Error(), spec.BaseFile) {
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
