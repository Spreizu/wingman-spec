// Package adr promotes a change's ADRs (changes/<change>/adrs/<slug>.md) to the specs root's adrs/NNNN-<slug>.md.
// The front matter line `source: <change>/<slug>` is the identity of a promoted ADR, so promoting twice is a no-op.
package adr

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Readme is the static adrs/README.md (no table: a generated table conflicts between parallel branches).
const Readme = "# Architecture Decision Records\n\nOne file per decision: `NNNN-<slug>.md`. List them with `wingman-spec adrs`.\n"

var (
	frontMatter = regexp.MustCompile(`(?s)^---\n(.*?)\n---\n?(.*)$`)
	numbered    = regexp.MustCompile(`^(\d{4})-(.+)\.md$`)
	statusLine  = regexp.MustCompile(`(?m)^status:.*$`)
)

// Doc is a Markdown file with simple `key: value` front matter.
type Doc struct {
	Keys  []string
	Value map[string]string
	Body  string
}

// Parse splits front matter and body. A file without front matter has an empty Value.
func Parse(src string) Doc {
	d := Doc{Value: map[string]string{}}
	m := frontMatter.FindStringSubmatch(strings.ReplaceAll(src, "\r\n", "\n"))
	if m == nil {
		d.Body = src
		return d
	}
	for l := range strings.SplitSeq(m[1], "\n") {
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		d.Keys = append(d.Keys, k)
		d.Value[k] = scalar(v)
	}
	d.Body = m[2]
	return d
}

// scalar is a front matter value as YAML reads it: a quoted string without its quotes, otherwise the text before a ` #` comment.
func scalar(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
		if i := strings.IndexByte(v[1:], v[0]); i >= 0 {
			return v[1 : i+1]
		}
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v
}

func placeholder(v string) bool { return v == "" || strings.HasPrefix(v, "<!--") }

// Promoted is one file of adrs/.
type Promoted struct {
	File   string `json:"file"`
	Number int    `json:"number"`
	Slug   string `json:"slug"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Source string `json:"source,omitempty"`
}

// List reads adrs/NNNN-*.md sorted by file name.
func List(dir string) ([]Promoted, error) {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Promoted
	for _, e := range ents {
		m := numbered.FindStringSubmatch(e.Name())
		if e.IsDir() || m == nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		d := Parse(string(b))
		n, _ := strconv.Atoi(m[1])
		out = append(out, Promoted{e.Name(), n, m[2], d.Value["title"], d.Value["status"], d.Value["source"]})
	}
	return out, nil
}

// Result is what Promote did with one source ADR.
type Result struct {
	Slug   string `json:"slug"`
	Action string `json:"action"` // promoted, updated, unchanged, skipped
	File   string `json:"file,omitempty"`
}

// Promote writes every ADR of changeDir/adrs into dir. With dryRun it only reports.
func Promote(changeDir, change, dir string, dryRun bool) ([]Result, error) {
	srcs, err := filepath.Glob(filepath.Join(changeDir, "adrs", "*.md"))
	if err != nil || len(srcs) == 0 {
		return nil, err
	}
	have, err := List(dir)
	if err != nil {
		return nil, err
	}
	var results []Result
	var writes []func() error
	next := 1
	for _, p := range have {
		next = max(next, p.Number+1)
	}
	for _, src := range srcs {
		slug := strings.TrimSuffix(filepath.Base(src), ".md")
		b, err := os.ReadFile(src)
		if err != nil {
			return nil, err
		}
		d := Parse(string(b))
		// a none record (file none.md, or status None) says the change made no decision: never promoted
		if strings.EqualFold(slug, "none") || strings.EqualFold(d.Value["status"], "none") {
			results = append(results, Result{slug, "skipped", ""})
			continue
		}
		for _, k := range []string{"title", "date"} {
			if placeholder(d.Value[k]) {
				return nil, fmt.Errorf("%s: %s is empty or still the template text: fill it in before sync", filepath.Join("adrs", slug+".md"), k)
			}
		}
		source := change + "/" + slug
		status, file := "Accepted", ""
		i := slices.IndexFunc(have, func(p Promoted) bool { return p.Source == source })
		if i >= 0 {
			file = have[i].File
			if s := have[i].Status; strings.HasPrefix(s, "Superseded") || strings.HasPrefix(s, "Deprecated") {
				status = s
			}
		} else {
			file = fmt.Sprintf("%04d-%s.md", next, slug)
			have = append(have, Promoted{File: file, Number: next, Slug: slug, Source: source})
			next++
		}
		fm := []string{"title: " + d.Value["title"], "status: " + status, "date: " + d.Value["date"], "change: " + change, "source: " + source}
		sup := d.Value["supersedes"]
		if !placeholder(sup) {
			fm = append(fm, "supersedes: "+sup)
		}
		text := "---\n" + strings.Join(fm, "\n") + "\n---\n" + d.Body
		target := filepath.Join(dir, file)
		old, _ := os.ReadFile(target)
		action := "promoted"
		switch {
		case string(old) == text:
			action = "unchanged"
		case i >= 0:
			action = "updated"
		}
		results = append(results, Result{slug, action, file})
		if action != "unchanged" {
			writes = append(writes, func() error { return os.WriteFile(target, []byte(text), 0o644) })
		}
		if !placeholder(sup) {
			w, err := supersede(dir, have, sup, file)
			if err != nil {
				return nil, err
			}
			if w != nil {
				writes = append(writes, w)
			}
		}
	}
	if dryRun || len(writes) == 0 {
		return results, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "README.md")); errors.Is(err, fs.ErrNotExist) {
		writes = append(writes, func() error { return os.WriteFile(filepath.Join(dir, "README.md"), []byte(Readme), 0o644) })
	}
	for _, w := range writes {
		if err := w(); err != nil {
			return nil, err
		}
	}
	return results, nil
}

// supersede marks adrs/<number>-*.md as superseded by file.
func supersede(dir string, have []Promoted, number, by string) (func() error, error) {
	n, err := strconv.Atoi(number)
	i := slices.IndexFunc(have, func(p Promoted) bool { return p.Number == n && p.File != by })
	if err != nil || i < 0 {
		return nil, fmt.Errorf("supersedes: %s: no ADR adrs/%s-*.md", number, number)
	}
	path := filepath.Join(dir, have[i].File)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	status := "Superseded by " + by[:4]
	if strings.Contains(string(b), "status: "+status) {
		return nil, nil
	}
	text := statusLine.ReplaceAllLiteralString(string(b), "status: "+status)
	return func() error { return os.WriteFile(path, []byte(text), 0o644) }, nil
}

// Check reports source ADRs of a change that are not promoted or out of date, and promoted numbers used twice.
func Check(changeDir, change, dir string) ([]string, error) {
	res, err := Promote(changeDir, change, dir, true)
	if err != nil {
		return []string{err.Error()}, nil
	}
	var probs []string
	for _, r := range res {
		switch r.Action {
		case "promoted":
			probs = append(probs, fmt.Sprintf("adrs/%s.md: NOT PROMOTED", r.Slug))
		case "updated":
			probs = append(probs, fmt.Sprintf("adrs/%s.md: promoted as %s but OUT OF DATE", r.Slug, r.File))
		}
	}
	return append(probs, Duplicates(dir)...), nil
}

// Duplicates lists numbers that two promoted ADRs share (parallel branches).
func Duplicates(dir string) []string {
	have, _ := List(dir)
	seen := map[int]string{}
	var probs []string
	for _, p := range have {
		if first, ok := seen[p.Number]; ok {
			probs = append(probs, fmt.Sprintf("%s and %s share number %04d: run `wingman-spec adrs --fix` and commit the renames", first, p.File, p.Number))
			continue
		}
		seen[p.Number] = p.File
	}
	return probs
}

// Rename is one renumbered ADR.
type Rename struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Renumber gives every ADR that shares a number with an earlier one (by file name) the next free number.
func Renumber(dir string) ([]Rename, error) {
	have, err := List(dir)
	if err != nil {
		return nil, err
	}
	top := 0
	for _, p := range have {
		top = max(top, p.Number)
	}
	seen := map[int]bool{}
	out := []Rename{}
	for _, p := range have {
		if !seen[p.Number] {
			seen[p.Number] = true
			continue
		}
		top++
		to := fmt.Sprintf("%04d-%s.md", top, p.Slug)
		if err := os.Rename(filepath.Join(dir, p.File), filepath.Join(dir, to)); err != nil {
			return out, err
		}
		out = append(out, Rename{p.File, to})
	}
	return out, nil
}
