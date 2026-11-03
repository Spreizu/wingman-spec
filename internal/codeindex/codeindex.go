// Package codeindex lists and reads the scannable files of a code root once per command.
package codeindex

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Spreizu/wingman-spec/internal/gitx"
)

const maxBytes = 1 << 20

// Skip is a file the scan could not read.
type Skip struct {
	File string `json:"file"`
	Why  string `json:"why"`
}

// File is one scannable regular file.
type File struct {
	Rel  string
	Text string // empty when the file is binary, too large, or unreadable
}

// Index is the scannable files of one code root, with their contents when they were readable.
type Index struct {
	Root    string
	Files   []File
	Skipped []Skip
}

// Scan lists the scannable files (git ls-files -z, else a walk) and reads them with a worker pool.
func Scan(root string, scannable func(string) bool) *Index {
	idx := &Index{Root: root}
	rels := listFiles(root)
	var jobs []string
	for _, f := range rels {
		if scannable != nil && !scannable(f) {
			continue
		}
		jobs = append(jobs, f)
	}
	type result struct {
		f   File
		sk  *Skip
		ok  bool
		rel string
	}
	out := make([]result, len(jobs))
	workers := min(8, max(1, len(jobs)))
	ch := make(chan int)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for i := range ch {
				rel := jobs[i]
				p := filepath.Join(root, rel)
				st, err := os.Stat(p)
				if err != nil {
					out[i] = result{sk: &Skip{File: rel, Why: err.Error()}, rel: rel}
					continue
				}
				if !st.Mode().IsRegular() {
					continue
				}
				if st.Size() > maxBytes {
					out[i] = result{ok: true, f: File{Rel: rel}, rel: rel}
					continue
				}
				b, err := os.ReadFile(p)
				if err != nil {
					out[i] = result{sk: &Skip{File: rel, Why: err.Error()}, rel: rel}
					continue
				}
				s := string(b)
				if strings.Contains(s, "\x00") {
					out[i] = result{ok: true, f: File{Rel: rel}, rel: rel}
					continue
				}
				out[i] = result{ok: true, f: File{Rel: rel, Text: s}, rel: rel}
			}
		})
	}
	for i := range jobs {
		ch <- i
	}
	close(ch)
	wg.Wait()
	for _, r := range out {
		if r.sk != nil {
			idx.Skipped = append(idx.Skipped, *r.sk)
			continue
		}
		if r.ok {
			idx.Files = append(idx.Files, r.f)
		}
	}
	return idx
}

// RelPaths is the relative paths in listing order.
func (idx *Index) RelPaths() []string {
	if idx == nil {
		return nil
	}
	out := make([]string, len(idx.Files))
	for i, f := range idx.Files {
		out[i] = f.Rel
	}
	return out
}

// Text of a relative path ("" when missing or unread).
func (idx *Index) Text(rel string) string {
	if idx == nil {
		return ""
	}
	for _, f := range idx.Files {
		if f.Rel == rel {
			return f.Text
		}
	}
	return ""
}

func listFiles(root string) []string {
	files, ok := gitx.Z(root, nil, "-c", "core.quotepath=off", "ls-files", "-z", "-co", "--exclude-standard")
	if ok {
		return files
	}
	var walk []string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != root && skipDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		walk = append(walk, filepath.ToSlash(rel))
		return nil
	})
	return walk
}

func skipDir(name string) bool {
	switch name {
	case "node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".venv", "venv", "target", "__pycache__",
		".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".wingman-spec", ".cursor", ".claude", ".agents", ".codex":
		return true
	}
	return false
}
