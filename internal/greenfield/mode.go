package greenfield

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// Modes.
const (
	Greenfield     = "greenfield"
	Brownfield     = "brownfield"
	InProgress     = "greenfield-in-progress"
	Implementation = "implementation"
	Unsupported    = "unsupported"
)

var skipDirs = map[string]bool{".git": true, "node_modules": true, "docs": true, "doc": true, "vendor": true, "dist": true, "build": true,
	"out": true, "coverage": true, "__pycache__": true, ".venv": true, "venv": true, "target": true, "openspec": true, "adr": true}

var srcSkip = regexp.MustCompile(`(?i)(?:\.config\.[a-z]+|\.d\.ts|\.min\.js)$|^(?:setup\.py|conftest\.py)$`)

type scan struct {
	files, lines int
	sample       []string
}

// sourceScan counts the source files outside docs, config and the specs (non-trivial = at least 30 non-blank lines).
func sourceScan(root string) scan {
	var out scan
	seen := 0
	var walk func(dir, rel string)
	walk = func(dir, rel string) {
		ents, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			if seen > 8000 {
				return
			}
			n := e.Name()
			if e.IsDir() {
				if skipDirs[n] || (strings.HasPrefix(n, ".") && rel == "") {
					continue
				}
				walk(filepath.Join(dir, n), path.Join(rel, n))
				continue
			}
			seen++
			if !testpaths.IsCode(n) || srcSkip.MatchString(n) {
				continue
			}
			t, ok := read(filepath.Join(dir, n))
			if !ok {
				continue
			}
			c := 0
			for l := range strings.SplitSeq(t, "\n") {
				if strings.TrimSpace(l) != "" {
					c++
				}
			}
			out.files++
			out.lines += c
			if len(out.sample) < 3 {
				out.sample = append(out.sample, path.Join(rel, n))
			}
		}
	}
	walk(root, "")
	return out
}

// historyScan counts the distinct source paths git history touched (outside the skipped dirs).
func historyScan(root string) (int, []string) {
	if !isDir(filepath.Join(root, ".git")) {
		return 0, nil
	}
	out, ok := gitx.Run(root, nil, "log", "--name-only", "--pretty=format:", "-n", "500")
	if !ok {
		return 0, nil
	}
	var set []string
	for p := range strings.SplitSeq(out, "\n") {
		p = strings.TrimSpace(p)
		if p == "" || !testpaths.IsCode(p) || srcSkip.MatchString(path.Base(p)) || skipDirs[strings.Split(p, "/")[0]] || strings.HasPrefix(p, ".") || slices.Contains(set, p) {
			continue
		}
		set = append(set, p)
	}
	return len(set), set[:min(3, len(set))]
}

func (p *Project) activeChanges() []string {
	var out []string
	for _, n := range ls(p.Root.Changes(), "") {
		if n != layout.ArchiveDir && isDir(filepath.Join(p.Root.Changes(), n)) {
			out = append(out, n)
		}
	}
	return out
}

func (p *Project) archivedChanges() []string {
	var out []string
	for _, n := range ls(p.Root.Archive(), "") {
		if isDir(filepath.Join(p.Root.Archive(), n)) {
			out = append(out, n)
		}
	}
	return out
}

// Marker is the file that says the greenfield flow was started here.
func (p *Project) Marker() string { return p.path("greenfield.yaml") }

// Slice is one roadmap file.
type slice struct {
	ID, File, Body string
	Data           FM
	Has            bool
	// derived
	Title, Size, FileStatus, Milestone, Status, Required string
	Deps, Covers, Tests                                  []string
	Skeleton                                             bool
	Requirements                                         int
}

func (p *Project) readSlices() []*slice {
	dir := p.path("roadmap")
	var out []*slice
	for _, f := range ls(dir, ".md") {
		d, body, has := parseFM(readS(filepath.Join(dir, f)))
		out = append(out, &slice{ID: strings.TrimSuffix(f, ".md"), File: filepath.Join(dir, f), Data: d, Body: body, Has: has})
	}
	return out
}

func sliceChange(id string) string { return "slice-" + id }

var (
	tickedRE    = regexp.MustCompile(`(?m)^\s*[-*]\s+\[[xX]\]`)
	archDateRE  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-(?:\d{4}-)?`)
	statusOrder = []string{"planned", "proposed", "applying", "done"}
)

// sliceState is planned | proposed | applying | done, from the changes themselves.
func (p *Project) sliceState(id string) string {
	name := sliceChange(id)
	dir := p.Root.Change(name)
	if isDir(dir) {
		if tickedRE.MatchString(readS(filepath.Join(dir, "tasks.md"))) {
			return "applying"
		}
		return "proposed"
	}
	for _, n := range p.archivedChanges() {
		if archDateRE.ReplaceAllString(n, "") == name {
			return "done"
		}
	}
	return "planned"
}

func (p *Project) slicesApplied() []string {
	var out []string
	for _, s := range p.readSlices() {
		st := p.sliceState(s.ID)
		fs := s.Data.Str("status")
		if st == "applying" || st == "done" || fs == "applying" || fs == "done" {
			out = append(out, s.ID)
		}
	}
	return out
}

// Signal is one piece of evidence behind a mode.
type Signal struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// Mode is the project mode and the evidence behind it.
type Mode struct {
	Mode          string   `json:"mode"`
	Marker        bool     `json:"marker"`
	Signals       []Signal `json:"signals"`
	Started       string   `json:"started,omitempty"`
	ConfirmedBy   string   `json:"confirmed_by,omitempty"`
	MarkerMissing bool     `json:"marker_missing,omitempty"`
}

// ModeOf is the project mode. Pure reads; never writes.
func (p *Project) ModeOf() Mode {
	out := Mode{Mode: Greenfield, Signals: []Signal{}}
	if p.Root.Kind == layout.Linked {
		out.Mode = Unsupported
		out.Signals = append(out.Signals, Signal{"layout", "the specs live in a linked specs repository"})
		return out
	}
	if t, ok := read(p.Marker()); ok {
		d, _, _ := parseFM("---\n" + t + "\n---\n")
		out.Marker = true
		applied := p.slicesApplied()
		out.Mode = InProgress
		if len(applied) > 0 {
			out.Mode = Implementation
			out.Signals = append(out.Signals, Signal{"slice-applied", strings.Join(applied, ", ")})
		}
		out.Started, out.ConfirmedBy = d.Str("started"), d.Str("confirmed_by")
		return out
	}
	own := isDir(p.G()) || isDir(p.path("roadmap"))
	code := p.Root.Code
	s := sourceScan(code)
	hn, hs := historyScan(code)
	if s.lines >= 30 {
		out.Signals = append(out.Signals, Signal{"source", fmt.Sprintf("%d source file(s), %d lines (%s)", s.files, s.lines, strings.Join(s.sample, ", "))})
	}
	if hn >= 3 {
		out.Signals = append(out.Signals, Signal{"git-history", fmt.Sprintf("%d source path(s) in the history (%s)", hn, strings.Join(hs, ", "))})
	}
	if !own {
		first3 := func(l []string) string { return strings.Join(l[:min(3, len(l))], ", ") }
		if a := p.archivedChanges(); len(a) > 0 {
			out.Signals = append(out.Signals, Signal{"archived-changes", first3(a)})
		}
		if a := p.activeChanges(); len(a) > 0 {
			out.Signals = append(out.Signals, Signal{"active-changes", first3(a)})
		}
		if a := p.livingCaps(); len(a) > 0 {
			out.Signals = append(out.Signals, Signal{"living-specs", first3(a)})
		}
		if a := p.adrFiles(); len(a) > 0 {
			out.Signals = append(out.Signals, Signal{"adrs", first3(a)})
		}
	}
	switch {
	case len(out.Signals) > 0:
		out.Mode = Brownfield
	case own:
		out.Mode, out.MarkerMissing = InProgress, true
	}
	return out
}

func (p *Project) livingCaps() []string {
	var out []string
	for _, f := range ls(p.Root.LivingSpecs(), ".md") {
		out = append(out, strings.TrimSuffix(f, ".md"))
	}
	return out
}

func (p *Project) adrFiles() []string {
	var out []string
	for _, f := range ls(p.Root.ADRs(), ".md") {
		if f != "README.md" {
			out = append(out, f)
		}
	}
	return out
}

// Alternative is what to run instead, per mode.
var Alternative = map[string]string{
	Brownfield:     "This project already has code, history or specs, so it is not a new product. Use /spec-adopt [scope] to bring the existing code under spec control, /spec-propose <change> for new work, /spec-garden for the drift backlog.",
	Implementation: "The first slice is already applied: the specification phase is over. Use /spec-green-next for the next slice, /spec-propose <change> to amend the specs (rewriting the Why of a requirement or removing a requirement needs the owner), /spec-garden for the drift backlog. Greenfield commands are read-only now.",
	InProgress:     "A new-product spec is in progress here. Run /spec-green-start (it continues where the project is), or /spec-green-next once the handover is READY. /spec-adopt would document code that does not exist yet.",
	Unsupported:    "Greenfield commands support the layouts where the specs root is this repository (.wingman-spec/ next to the code, or the specs repository itself), not a linked specs layout. Run them in the specs repository.",
}

// For lists the modes each guarded command may run in.
var For = map[string][]string{
	"start":   {Greenfield, InProgress},
	"plan":    {InProgress},
	"status":  {Greenfield, InProgress, Implementation},
	"adopt":   {Greenfield, Brownfield},
	"next":    {InProgress, Implementation},
	"propose": {Greenfield, InProgress, Brownfield, Implementation},
	"garden":  {Greenfield, InProgress, Brownfield, Implementation},
}

// Allowed reports whether cmd may run in mode.
func Allowed(mode, cmd string) bool { return slices.Contains(For[cmd], mode) }

// Refusal is what a refused command prints.
type Refusal struct {
	Refused     bool     `json:"refused"`
	Command     string   `json:"command"`
	Mode        string   `json:"mode"`
	Why         []string `json:"why"`
	Alternative string   `json:"alternative"`
	Wrote       string   `json:"wrote"`
}

// Refuse builds the refusal of cmd in mode m.
func Refuse(m Mode, cmd string) Refusal {
	why := []string{}
	for _, s := range m.Signals {
		why = append(why, s.Kind+": "+s.Detail)
	}
	return Refusal{true, cmd, m.Mode, why, Alternative[m.Mode], "nothing"}
}

// Text is the refusal as text.
func (r Refusal) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "REFUSED: `%s` is not available in a %s project. Nothing was written.\n", r.Command, r.Mode)
	for _, w := range r.Why {
		b.WriteString("  - " + w + "\n")
	}
	b.WriteString(r.Alternative + "\n")
	return b.String()
}
