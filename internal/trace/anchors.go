package trace

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

var (
	skipExt = regexp.MustCompile(`(?i)\.(md|markdown|mdx|txt|json|jsonc|lock|lockb|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|map|min\.js|snap|csv|tsv|zip|gz|wasm)$`)
	skipDir = regexp.MustCompile(`^(node_modules|\.git|dist|build|out|coverage|vendor|\.venv|venv|target|__pycache__|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.wingman-spec|\.cursor|\.claude|\.agents|\.codex)$`)
)

// Ctx is the layout and configuration the checks read.
type Ctx struct {
	R   *layout.Root
	Cfg *config.Config
}

// Specs is the living specs directory.
func (c Ctx) Specs() string { return c.R.LivingSpecs() }

// specTop is true for a top-level directory of the specs root when the code root is the specs root (specs repo).
func (c Ctx) specTop(seg string) bool {
	if filepath.Clean(c.R.Code) != filepath.Clean(c.R.Specs) {
		return false
	}
	switch seg {
	case layout.SpecsDir, layout.ChangesDir, layout.ArchiveDir, layout.ADRsDir, "observed":
		return true
	}
	return false
}

// IsSpecPath reports a code-root-relative path that belongs to the specs or the run state, never to the code.
func (c Ctx) IsSpecPath(f string) bool {
	top, _, _ := strings.Cut(f, "/")
	if top == layout.Dir || c.specTop(top) {
		return true
	}
	if rel, err := filepath.Rel(c.R.Code, c.R.Specs); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
		return f == rel || strings.HasPrefix(f, filepath.ToSlash(rel)+"/")
	}
	return false
}

// IsScannable reports a file the anchor scan reads: not under a vendor, build or spec directory, not a data file.
func (c Ctx) IsScannable(f string) bool {
	segs := strings.Split(f, "/")
	for i, s := range segs[:len(segs)-1] {
		if skipDir.MatchString(s) || (i == 0 && c.specTop(s)) {
			return false
		}
	}
	return !skipExt.MatchString(f)
}

// CodeFiles lists the scannable files of the code root (git ls-files, else a walk).
func (c Ctx) CodeFiles() []string {
	root := c.R.Code
	files := gitx.Lines(root, "-c", "core.quotepath=off", "ls-files", "-co", "--exclude-standard")
	if files == nil {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if p != root && skipDir.MatchString(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			files = append(files, filepath.ToSlash(rel))
			return nil
		})
	}
	var out []string
	for _, f := range files {
		if !c.IsScannable(f) {
			continue
		}
		if st, err := os.Stat(filepath.Join(root, f)); err == nil && st.Mode().IsRegular() {
			out = append(out, f)
		}
	}
	return out
}

// ScanAnchors returns every marker in the given files (all code files when nil).
func (c Ctx) ScanAnchors(only []string) []anchors.Marker {
	if only == nil {
		only = c.CodeFiles()
	}
	var out []anchors.Marker
	for _, f := range only {
		p := filepath.Join(c.R.Code, f)
		st, err := os.Stat(p)
		if err != nil || !st.Mode().IsRegular() || st.Size() > 1<<20 {
			continue
		}
		b, err := os.ReadFile(p)
		s := string(b)
		if err != nil || strings.Contains(s, "\x00") || !strings.Contains(s, "@spec") {
			continue
		}
		for _, m := range anchors.MarkersIn(s) {
			m.File, m.Test = f, testpaths.IsTestPath(f)
			out = append(out, m)
		}
	}
	return out
}

// retired lists capabilities an archived change carried a delta for that have no living spec now.
func (c Ctx) retired() map[string]bool {
	gone := map[string]bool{}
	ents, _ := os.ReadDir(c.R.Archive())
	for _, e := range ents {
		if e.IsDir() {
			for _, sf := range SpecFilesOf(filepath.Join(c.R.Archive(), e.Name(), "specs")) {
				gone[sf.Cap] = true
			}
		}
	}
	for cap := range gone {
		if _, err := os.Stat(filepath.Join(c.Specs(), cap+".md")); err == nil {
			delete(gone, cap)
		}
	}
	return gone
}

// ReqAnchors are the code and test files anchored to one requirement.
type ReqAnchors struct {
	Code  map[string]bool
	Tests map[string]bool
	Why   string
}

// StaleTag is a test tag naming a scenario that does not exist.
type StaleTag struct {
	Tag   string   `json:"tag"`
	Files []string `json:"files"`
	Why   string   `json:"why"`
}

// Facts are the anchors of a requirement set.
type Facts struct {
	Requirements map[string]*ReqAnchors
	Unresolved   []anchors.Marker
	StaleTags    []StaleTag
	Tags         map[string][]string
	Markers      []anchors.Marker
}

// AnchorFacts matches the markers and test tags of the code root against reqs.
func (c Ctx) AnchorFacts(reqs *Reqs) Facts {
	f := Facts{Requirements: map[string]*ReqAnchors{}, Markers: c.ScanAnchors(nil)}
	f.Tags = quality.TraceTags(quality.ListTestFiles(c.R.Code), c.R.Code)
	sc := scenarioIndex(reqs)
	for _, k := range reqs.keys {
		f.Requirements[k] = &ReqAnchors{Code: map[string]bool{}, Tests: map[string]bool{}, Why: reqs.m[k].WhyText()}
	}
	for _, m := range f.Markers {
		x, ok := f.Requirements[m.Key]
		if !ok {
			f.Unresolved = append(f.Unresolved, m)
			continue
		}
		if m.Test {
			x.Tests[m.File] = true
		} else {
			x.Code[m.File] = true
		}
	}
	caps := map[string]bool{}
	for _, k := range reqs.keys {
		caps[reqs.m[k].Cap] = true
	}
	gone := c.retired()
	tags := make([]string, 0, len(f.Tags))
	for t := range f.Tags {
		tags = append(tags, t)
	}
	slices.Sort(tags)
	for _, tag := range tags {
		files := f.Tags[tag]
		if owner, ok := sc[tag]; ok {
			for _, fl := range files {
				f.Requirements[owner].Tests[fl] = true
			}
			continue
		}
		cap, _, _ := strings.Cut(tag, "/")
		switch {
		case caps[cap]:
			f.StaleTags = append(f.StaleTags, StaleTag{tag, files, "no such scenario in the specs"})
		case gone[cap]:
			f.StaleTags = append(f.StaleTags, StaleTag{tag, files, "capability no longer in the specs"})
		}
	}
	return f
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// IndexEntry is one requirement of the derived anchor index.
type IndexEntry struct {
	Why   string   `json:"why"`
	Code  []string `json:"code"`
	Tests []string `json:"tests"`
}

// Index is the derived anchor index (`anchors --json`); it is never stored.
type Index struct {
	Version      int                   `json:"version"`
	Capabilities []string              `json:"capabilities"`
	Requirements map[string]IndexEntry `json:"requirements"`
}

// AnchorIndex builds the index.
func AnchorIndex(reqs *Reqs, f Facts) Index {
	caps := map[string]bool{}
	ix := Index{Version: 1, Requirements: map[string]IndexEntry{}}
	for _, k := range reqs.keys {
		caps[reqs.m[k].Cap] = true
		x := f.Requirements[k]
		ix.Requirements[k] = IndexEntry{Why: x.Why, Code: sortedKeys(x.Code), Tests: sortedKeys(x.Tests)}
	}
	ix.Capabilities = sortedKeys(caps)
	return ix
}

// Problem is one finding of a traceability check.
type Problem struct {
	Severity string `json:"severity"` // error | warning | info
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	File     string `json:"file"`
	Line     int    `json:"line"`
}

// BySeverity drops everything in off mode and downgrades errors in warn mode.
func BySeverity(ps []Problem, mode string) []Problem {
	if mode == "off" {
		return []Problem{}
	}
	out := make([]Problem, 0, len(ps))
	for _, p := range ps {
		if mode == "warn" && p.Severity == "error" {
			p.Severity = "warning"
		}
		out = append(out, p)
	}
	return out
}

// LintResult is what AnchorLint found.
type LintResult struct {
	Problems []Problem
	Facts    Facts
	Eff      *Reqs
	Mine     []string
	Summary  map[string]any
}

// AnchorLint checks the change: every requirement it adds or modifies has a code anchor and a test anchor, every marker
// resolves, markers sit well and fit.
func (c Ctx) AnchorLint(changeDir string) LintResult {
	eff := Effective(c.Specs(), changeDir)
	facts := c.AnchorFacts(eff)
	var ps []Problem
	P := func(sev, kind, text string) { ps = append(ps, Problem{Severity: sev, Kind: kind, Text: text}) }
	var mine []string
	for _, d := range Deltas(changeDir) {
		for _, r := range d.Reqs {
			if r.Op == "ADDED" || r.Op == "MODIFIED" {
				mine = append(mine, d.Cap+"/"+r.Slug)
			}
		}
	}
	noCode, noTest := []string{}, []string{}
	for _, k := range mine {
		x, ok := facts.Requirements[k]
		if !ok {
			continue
		}
		if len(x.Code) == 0 {
			noCode = append(noCode, k)
		}
		if len(x.Tests) == 0 {
			noTest = append(noTest, k)
		}
	}
	if len(noCode) > 0 {
		P("error", "no-code-anchor", "requirement(s) without a code anchor: "+strings.Join(noCode, ", ")+". Add a comment `@spec <capability>/<requirement-slug>` next to the code that implements each (any comment syntax).")
	}
	if len(noTest) > 0 {
		P("error", "no-test-anchor", "requirement(s) without a test anchor: "+strings.Join(noTest, ", ")+". Tag a test of one of its scenarios `[capability/scenario-slug]`, or put `@spec <capability>/<requirement-slug>` in a test file.")
	}
	for _, u := range facts.Unresolved {
		P("error", "unresolved-marker", fmt.Sprintf("%s:%d: `@spec %s` does not resolve to a requirement (the slug is the requirement name lower-cased with dashes; run `wingman-spec anchors <change>` to list the valid ones)", u.File, u.Line, u.Key))
	}
	for _, s := range facts.StaleTags {
		P("error", "stale-test-tag", fmt.Sprintf("%s: test tag [%s]: %s", s.Files[0], s.Tag, s.Why))
	}
	var keys map[string]bool
	if len(mine) > 0 {
		keys = map[string]bool{}
		for _, k := range mine {
			keys[k] = true
		}
	}
	lv := LevelsOf(c.Cfg)
	if lv.Placement != "off" {
		sev := "warning"
		if lv.Placement == "error" {
			sev = "error"
		}
		for _, x := range c.PlacementProblems(keys, nil) {
			ps = append(ps, Problem{Severity: sev, Kind: "marker-placement", Text: fmt.Sprintf("%s:%d: %s: %s", x.File, x.Line, x.Kind, x.Text), File: x.File, Line: x.Line})
		}
	}
	fit, level := c.FitProblems(keys, nil)
	for _, x := range fit {
		sev := "warning"
		if level == "error" {
			sev = "error"
		}
		ps = append(ps, Problem{Severity: sev, Kind: x.Kind, Text: x.Text, File: x.File, Line: x.Line})
	}
	if ps == nil {
		ps = []Problem{}
	}
	return LintResult{Problems: ps, Facts: facts, Eff: eff, Mine: mine, Summary: map[string]any{
		"requirements": eff.Len(), "change_requirements": len(mine), "without_code": noCode, "without_test": noTest,
		"unresolved": len(facts.Unresolved), "stale_tags": len(facts.StaleTags),
	}}
}

var (
	reviewedRE = regexp.MustCompile(`(?im)^[ \t]*(?:[-*][ \t]*)?(?:\[[ xX]\][ \t]*)?\**Reviewed anchors\**:[ \t]*(.+)$`)
	specLineRE = regexp.MustCompile(`(?i)^\s*[-*]?\s*(?:\[[ xX]\]\s*)?\**Spec\**:\s*(.+)$`)
	keyWordRE  = regexp.MustCompile(`\b([a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*)\b`)
)

// Mentions is what a change names, for the anchor guard.
type Mentions struct{ Listed, Reviewed, Modified, Removed map[string]bool }

// ChangeMentions collects the requirement keys a change names: every delta requirement, the requirements its tasks'
// Spec: lines name, `Reviewed anchors:` lines, MODIFIED and REMOVED keys.
func (c Ctx) ChangeMentions(changeDir string) Mentions {
	m := Mentions{map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}}
	for _, d := range Deltas(changeDir) {
		for _, r := range d.Reqs {
			k := d.Cap + "/" + r.Slug
			m.Listed[k] = true
			if r.Op == "MODIFIED" {
				m.Modified[k] = true
			}
			if r.Op == "REMOVED" {
				m.Removed[k] = true
			}
		}
		for _, rn := range d.Renames {
			m.Listed[d.Cap+"/"+rn.FromSlug] = true
			m.Listed[d.Cap+"/"+rn.ToSlug] = true
		}
	}
	scens := append(quality.SpecScenarios(filepath.Join(changeDir, "specs")), quality.SpecScenarios(c.Specs())...)
	for l := range strings.SplitSeq(readIf(filepath.Join(changeDir, "tasks.md")), "\n") {
		sm := specLineRE.FindStringSubmatch(l)
		if sm == nil {
			continue
		}
		refs := quality.SpecRefs(sm[1], scens)
		for _, sc := range append(refs.Explicit, refs.Implicit...) {
			if sc.Capability != "" && sc.Requirement != "" {
				m.Listed[sc.Capability+"/"+spec.Slug(sc.Requirement)] = true
			}
		}
		for _, k := range keyWordRE.FindAllStringSubmatch(sm[1], -1) {
			m.Listed[k[1]] = true
		}
	}
	for _, f := range []string{"tasks.md", "progress.md"} {
		for _, rm := range reviewedRE.FindAllStringSubmatch(readIf(filepath.Join(changeDir, f)), -1) {
			for _, k := range keyWordRE.FindAllStringSubmatch(rm[1], -1) {
				m.Reviewed[k[1]] = true
			}
		}
	}
	return m
}

// PlacementProblems lists placement findings in the given files (all files when nil); keys limits them to those requirements.
func (c Ctx) PlacementProblems(keys map[string]bool, files []string) []anchors.PlacementFinding {
	if files == nil {
		files = c.CodeFiles()
	}
	var out []anchors.PlacementFinding
	for _, f := range files {
		s := readIf(filepath.Join(c.R.Code, f))
		if s == "" || len(s) > 1<<20 || strings.Contains(s, "\x00") || !strings.Contains(s, "@spec") {
			continue
		}
		for _, x := range anchors.Placement(s, testpaths.IsTestPath(f)) {
			if keys == nil || slices.ContainsFunc(x.Keys, func(k string) bool { return keys[k] }) {
				x.File = f
				out = append(out, x)
			}
		}
	}
	return out
}

// FitProblems lists anchor-fit findings (only in files when given; only of keys when given) and the fit level.
func (c Ctx) FitProblems(keys map[string]bool, files []string) ([]anchors.FitFinding, string) {
	lv := LevelsOf(c.Cfg)
	if lv.Fit == "off" {
		return nil, "off"
	}
	cfg := c.Cfg
	if cfg == nil {
		cfg = config.Defaults()
	}
	reqs := map[string]anchors.FitReq{}
	capNames := map[string]bool{}
	taskCaps := map[string]map[string]bool{}
	add := func(cap string, list []*Requirement) {
		capNames[cap] = true
		for _, r := range list {
			reqs[cap+"/"+r.Slug] = anchors.FitReq{Name: r.Name, Block: r.Block, Cap: cap}
		}
	}
	for _, sf := range SpecFilesOf(c.Specs()) {
		add(sf.Cap, ParseSpec(readIf(sf.File)).Reqs)
	}
	ents, _ := os.ReadDir(c.R.Changes())
	for _, e := range ents {
		if !e.IsDir() || e.Name() == layout.ArchiveDir {
			continue
		}
		dir := filepath.Join(c.R.Changes(), e.Name())
		for _, d := range Deltas(dir) {
			add(d.Cap, d.Reqs)
		}
		plan := tasks.Parse(readIf(filepath.Join(dir, "tasks.md")))
		for _, t := range plan.All() {
			caps := map[string]bool{}
			for _, m := range keyWordRE.FindAllStringSubmatch(t.Details["spec"], -1) {
				cp, _, _ := strings.Cut(m[1], "/")
				caps[cp] = true
			}
			if len(caps) != 1 {
				continue
			}
			for cp := range caps {
				for _, f := range t.Files {
					if taskCaps[f] == nil {
						taskCaps[f] = map[string]bool{}
					}
					taskCaps[f][cp] = true
				}
			}
		}
	}
	var texts []anchors.FitFile
	seen := map[string]bool{}
	for _, m := range c.ScanAnchors(nil) {
		if seen[m.File] {
			continue
		}
		seen[m.File] = true
		t := readIf(filepath.Join(c.R.Code, m.File))
		if t != "" && len(t) < 1<<20 && !strings.Contains(t, "\x00") {
			texts = append(texts, anchors.FitFile{File: m.File, Text: t, Test: testpaths.IsTestPath(m.File)})
		}
	}
	many := map[string]bool{}
	for _, k := range cfg.AnchorMany {
		many[k] = true
	}
	found := anchors.FitFindings(anchors.FitOpts{Files: texts, Reqs: reqs, CapNames: capNames, TaskCaps: taskCaps, Max: cfg.AnchorMax, Many: many})
	var out []anchors.FitFinding
	for _, x := range found {
		if (keys == nil || keys[x.Key]) && (files == nil || slices.Contains(files, x.File)) {
			out = append(out, x)
		}
	}
	return out, lv.Fit
}

// MarkerProblem is a marker that does not resolve, with the most similar key.
type MarkerProblem struct {
	anchors.Marker
	Hint string `json:"hint,omitempty"`
}

// MarkerProblems lists unresolved markers in the given (changed) files.
func (c Ctx) MarkerProblems(changeDir string, files []string) []MarkerProblem {
	eff := Effective(c.Specs(), changeDir)
	var out []MarkerProblem
	if files == nil {
		files = []string{}
	}
	for _, m := range c.ScanAnchors(files) {
		if !eff.Has(m.Key) {
			out = append(out, MarkerProblem{m, Nearest(m.Key, eff.Keys())})
		}
	}
	return out
}

var nonAlnumRE = regexp.MustCompile(`[^a-z0-9]+`)

func wordSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range nonAlnumRE.Split(s, -1) {
		if w != "" {
			out[w] = true
		}
	}
	return out
}

// Nearest is the most similar known key of the same capability (word overlap), or "".
func Nearest(key string, keys []string) string {
	cap, slug, _ := strings.Cut(key, "/")
	w := wordSet(slug)
	best, bs := "", 0.0
	for _, k := range keys {
		kc, ks, _ := strings.Cut(k, "/")
		if kc != cap {
			continue
		}
		kw := wordSet(ks)
		n := 0
		for x := range w {
			if kw[x] {
				n++
			}
		}
		s := float64(n) / float64(max(len(w), len(kw), 1))
		if s > bs {
			bs, best = s, k
		}
	}
	if bs >= 0.34 {
		return best
	}
	return ""
}
