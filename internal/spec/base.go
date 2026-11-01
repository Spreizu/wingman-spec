package spec

import (
	"encoding/json"
	"errors"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// BaseFile is the file in a change folder that records the base of each delta spec (see Base).
const BaseFile = "spec-base.json"

type baseFile struct {
	Version      int             `json:"version"`
	Capabilities map[string]Base `json:"capabilities"`
}

// ReadBases reads the bases of a change folder (an empty map when it has none yet).
func ReadBases(changeDir string) (map[string]Base, error) {
	b, err := os.ReadFile(filepath.Join(changeDir, BaseFile))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]Base{}, nil
	}
	if err != nil {
		return nil, err
	}
	var f baseFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, errors.New(BaseFile + ": " + err.Error())
	}
	if f.Capabilities == nil {
		f.Capabilities = map[string]Base{}
	}
	return f.Capabilities, nil
}

// PinBases records the base of every delta spec of the change that has none yet, from the living specs as they are
// now, and drops what no delta needs any more. With rebase every entry is recorded again from the living specs, and
// the requirements whose recorded base moved are returned. A recorded base is never changed otherwise. With write
// false nothing is written, and the bases are only returned.
func PinBases(changeDir, livingDir string, rebase, write bool) (bases map[string]Base, moved []string, err error) {
	old, err := ReadBases(changeDir)
	if err != nil && !rebase {
		return nil, nil, err
	}
	deltas, err := filepath.Glob(filepath.Join(changeDir, "specs", "*.md"))
	if err != nil {
		return nil, nil, err
	}
	now := map[string]Base{}
	for _, p := range deltas {
		capability := strings.TrimSuffix(filepath.Base(p), ".md")
		db, err := os.ReadFile(p)
		if err != nil {
			return nil, nil, err
		}
		lb, err := os.ReadFile(filepath.Join(livingDir, capability+".md"))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, nil, err
		}
		d := ParseDelta(string(db))
		fresh := BaseOf(string(lb), d)
		prev, had := old[capability]
		if !had || rebase {
			if had && prev.Exists != fresh.Exists {
				moved = append(moved, capability)
			}
			for k, h := range fresh.Requirements {
				if had && prev.Requirements[k] != "" && prev.Requirements[k] != h {
					moved = append(moved, capability+"/"+k)
				}
			}
			now[capability] = fresh
			continue
		}
		keep := Base{Exists: prev.Exists, Requirements: map[string]string{}}
		for _, n := range d.baseNames() {
			if h, ok := prev.Requirements[Key(n)]; ok {
				keep.Requirements[Key(n)] = h
			} else if h, ok := fresh.Requirements[Key(n)]; ok && prev.Exists {
				keep.Requirements[Key(n)] = h
			}
		}
		if len(keep.Requirements) == 0 {
			keep.Requirements = nil
		}
		now[capability] = keep
	}
	if !write || equalBases(old, now) {
		return now, moved, nil
	}
	path := filepath.Join(changeDir, BaseFile)
	if len(now) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, nil, err
		}
		return now, moved, nil
	}
	b, _ := json.MarshalIndent(baseFile{Version: 1, Capabilities: now}, "", "  ")
	return now, moved, WriteAtomic(map[string][]byte{path: append(b, '\n')})
}

func equalBases(a, b map[string]Base) bool {
	return maps.EqualFunc(a, b, func(x, y Base) bool { return x.Exists == y.Exists && maps.Equal(x.Requirements, y.Requirements) })
}

// WriteAtomic writes every file or none: each is written to a temporary file next to it first, then all are renamed
// into place, and a failed rename puts back what was renamed before it.
func WriteAtomic(files map[string][]byte) error {
	paths := slices.Sorted(maps.Keys(files))
	tmps := map[string]string{}
	cleanup := func() {
		for _, t := range tmps {
			_ = os.Remove(t)
		}
	}
	for _, p := range paths {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			cleanup()
			return err
		}
		f, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".tmp-*")
		if err != nil {
			cleanup()
			return err
		}
		tmps[p] = f.Name()
		_, err = f.Write(files[p])
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			err = os.Chmod(f.Name(), 0o644)
		}
		if err != nil {
			cleanup()
			return err
		}
	}
	type undo struct {
		path string
		old  []byte // nil: the file did not exist
	}
	var done []undo
	for _, p := range paths {
		old, rerr := os.ReadFile(p)
		if rerr != nil {
			old = nil
		}
		if err := os.Rename(tmps[p], p); err != nil {
			for _, u := range slices.Backward(done) {
				if u.old == nil {
					_ = os.Remove(u.path)
				} else {
					_ = os.WriteFile(u.path, u.old, 0o644)
				}
			}
			cleanup()
			return err
		}
		delete(tmps, p)
		done = append(done, undo{p, old})
	}
	return nil
}
