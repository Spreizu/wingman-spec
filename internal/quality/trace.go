package quality

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// TagRE matches a scenario trace tag `[capability/scenario-slug]`.
var TagRE = regexp.MustCompile(`\[([a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*)\]`)

var skipWalk = regexp.MustCompile(`^(node_modules|\.git|dist|build|\.wingman-spec)$`)

// GitFiles runs git with args in root and returns the output lines, or nil when git fails.
func GitFiles(root string, args ...string) []string {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	b, err := cmd.Output()
	if err != nil {
		return nil
	}
	var out []string
	for l := range strings.SplitSeq(string(b), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// ListTestFiles lists the test files of the code repo (tracked and untracked, git-ignored skipped; without git a walk).
// skip names top-level directories that hold no code (the specs folders of a specs repo).
func ListTestFiles(root string, skip ...string) []string {
	files := GitFiles(root, "ls-files", "-co", "--exclude-standard")
	if files == nil {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if p != root && skipWalk.MatchString(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			r, _ := filepath.Rel(root, p)
			files = append(files, filepath.ToSlash(r))
			return nil
		})
	}
	var out []string
	for _, f := range files {
		top, _, _ := strings.Cut(f, "/")
		if top == "node_modules" || top == ".wingman-spec" || slices.Contains(skip, top) || strings.Contains("/"+f, "/node_modules/") || !testpaths.IsTestFile(f) {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, f)); err == nil {
			out = append(out, f)
		}
	}
	return out
}

// TraceTags maps tag id -> files over the given test files (relative to root).
func TraceTags(files []string, root string) map[string][]string {
	tags := map[string][]string{}
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			continue
		}
		for _, m := range TagRE.FindAllStringSubmatch(string(b), -1) {
			if !slices.Contains(tags[m[1]], f) {
				tags[m[1]] = append(tags[m[1]], f)
			}
		}
	}
	return tags
}

// Covered is a scenario with the test files that tag it.
type Covered struct {
	ID string   `json:"id"`
	By []string `json:"by"`
}

// TraceResult says which scenarios tests tag, which the visual check covers and which nothing covers.
type TraceResult struct {
	Total   int         `json:"total"`
	Covered []Covered   `json:"covered"`
	Visual  []string    `json:"visual"`
	Missing []*Scenario `json:"missing"`
}

// Trace matches scenarios with tags; visual scenarios count as covered when visualCovers.
func Trace(scenarios []*Scenario, tags map[string][]string, visualCovers bool) TraceResult {
	r := TraceResult{Total: len(scenarios), Covered: []Covered{}, Visual: []string{}, Missing: []*Scenario{}}
	for _, s := range scenarios {
		switch by, ok := tags[s.ID]; {
		case ok:
			r.Covered = append(r.Covered, Covered{s.ID, by})
		case s.Visual && visualCovers:
			r.Visual = append(r.Visual, s.ID)
		default:
			r.Missing = append(r.Missing, s)
		}
	}
	return r
}

// Refs are the scenarios a task's Spec: line names.
type Refs struct {
	Explicit []*Scenario
	Implicit []*Scenario
	Unknown  []string
}

var (
	refIDRE    = regexp.MustCompile(`\[?([a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*)\]?`)
	refSplitRE = regexp.MustCompile(`\s*;\s*`)
	gtSplitRE  = regexp.MustCompile(`\s*>\s*`)
	parenRE    = regexp.MustCompile(`^(.*?)\s*\((.*)\)\s*$`)
	scenPfxRE  = regexp.MustCompile(`(?i)^\s*scenarios?\s*:\s*`)
	commaRE    = regexp.MustCompile(`\s*,\s*`)
	allRE      = regexp.MustCompile(`(?i)^all( scenarios)?$`)
)

// SpecRefs resolves a task's Spec: line. Parts are separated by `;`; a part is `cap/slug` (or `[cap/slug]`),
// `capability > Requirement > Scenario`, or `capability > Requirement (Scenario A, Scenario B | all scenarios)`.
func SpecRefs(line string, scenarios []*Scenario) Refs {
	var r Refs
	if line == "" {
		return r
	}
	add := func(arr *[]*Scenario, xs []*Scenario) {
		for _, x := range xs {
			if !slices.Contains(r.Explicit, x) && !slices.Contains(*arr, x) {
				*arr = append(*arr, x)
			}
		}
	}
	byID := func(id string) *Scenario {
		for _, s := range scenarios {
			if s.ID == id {
				return s
			}
		}
		return nil
	}
	for _, part0 := range refSplitRE.Split(line, -1) {
		part := strings.TrimSpace(strings.ReplaceAll(part0, "`", ""))
		if part == "" {
			continue
		}
		var ids []*Scenario
		for _, m := range refIDRE.FindAllStringSubmatch(part, -1) {
			if s := byID(m[1]); s != nil {
				ids = append(ids, s)
			}
		}
		if len(ids) > 0 && !strings.Contains(part, ">") {
			add(&r.Explicit, ids)
			continue
		}
		segs := gtSplitRE.Split(part, -1)
		if len(segs) < 2 {
			r.Unknown = append(r.Unknown, part)
			continue
		}
		capName := spec.Slug(segs[0])
		pm := parenRE.FindStringSubmatch(segs[1])
		reqName := segs[1]
		if pm != nil {
			reqName = pm[1]
		}
		reqName = spec.Slug(reqName)
		var inReq []*Scenario
		for _, s := range scenarios {
			if s.Capability == capName && spec.Slug(s.Requirement) == reqName {
				inReq = append(inReq, s)
			}
		}
		if len(inReq) == 0 {
			r.Unknown = append(r.Unknown, part)
			continue
		}
		var named []string
		switch {
		case len(segs) > 2 && segs[2] != "":
			named = []string{segs[2]}
		case pm != nil:
			named = commaRE.Split(scenPfxRE.ReplaceAllString(pm[2], ""), -1)
		default:
			add(&r.Implicit, inReq)
			continue
		}
		if slices.ContainsFunc(named, func(n string) bool { return allRE.MatchString(strings.TrimSpace(n)) }) {
			add(&r.Explicit, inReq)
			continue
		}
		var hits []*Scenario
		for _, n := range named {
			k := spec.Slug(n)
			var h *Scenario
			for _, s := range inReq {
				if spec.Slug(s.Name) == k {
					h = s
					break
				}
			}
			if h == nil && k != "" {
				for _, s := range inReq {
					if strings.HasPrefix(spec.Slug(s.Name), k) {
						h = s
						break
					}
				}
			}
			if h != nil {
				hits = append(hits, h)
			}
		}
		if len(hits) > 0 {
			add(&r.Explicit, hits)
		} else {
			add(&r.Implicit, inReq)
		}
	}
	r.Implicit = slices.DeleteFunc(r.Implicit, func(s *Scenario) bool { return slices.Contains(r.Explicit, s) })
	return r
}
