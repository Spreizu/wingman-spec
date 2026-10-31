// Package trace ties requirements to code: the requirement's Why, code anchors (`@spec <capability>/<slug>`), the drift
// report over the living specs, accepted gaps and the full sync check. Everything is derived from files and git at check
// time; nothing is stored.
package trace

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/spec"
)

// Requirement is one requirement of a living or delta spec.
type Requirement struct {
	Name       string     `json:"name"`
	Slug       string     `json:"slug"`
	Op         string     `json:"op"` // ADDED | MODIFIED | REMOVED | LIVING
	Line       int        `json:"line"`
	Why        *string    `json:"why"`
	Confirmed  *string    `json:"confirmed,omitempty"`
	Accepted   *string    `json:"accepted,omitempty"`
	acceptedAt int        // 0-based line of the Accepted: line, -1 when none
	Scenarios  []Scenario `json:"scenarios"`
	Block      string     `json:"-"`
	Baseline   bool       `json:"baseline,omitempty"`
	// filled by the readers
	Cap  string `json:"cap,omitempty"`
	Key  string `json:"key,omitempty"`
	File string `json:"file,omitempty"`
}

// WhyText is the Why or "".
func (r *Requirement) WhyText() string {
	if r.Why == nil {
		return ""
	}
	return *r.Why
}

// Scenario is one scenario heading.
type Scenario struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
	Line int    `json:"line"`
}

// Rename is one RENAMED line.
type Rename struct{ From, To, FromSlug, ToSlug string }

// Parsed is a parsed spec file.
type Parsed struct {
	Purpose  string
	Reqs     []*Requirement
	Renames  []Rename
	Baseline bool
}

var (
	fenceRE     = regexp.MustCompile("^\\s*(`{3,}|~{3,})\\s*(\\S*)")
	h2RE        = regexp.MustCompile(`^##\s+(.*?)\s*$`)
	opRE        = regexp.MustCompile(`(?i)^(ADDED|MODIFIED|REMOVED|RENAMED)\b`)
	purposeRE   = regexp.MustCompile(`(?i)^purpose\b`)
	reqRE       = regexp.MustCompile(`^###\s+Requirement:\s*(.*?)\s*$`)
	scenRE      = regexp.MustCompile(`^####\s+Scenario:\s*(.*?)\s*$`)
	renameRE    = regexp.MustCompile(`^\s*[-*]\s+(.+?)\s*->\s*(.+?)\s*$`)
	confirmedRE = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?\**Confirmed\**:\s*(.+?)\s*$`)
	acceptedRE  = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?\**Accepted\**:\s*(.+?)\s*$`)
	whyRE       = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?\**Why\**:\s*(.*?)\s*$`)
	htmlComment = regexp.MustCompile(`(?s)<!--.*?-->`)
	baselineRE  = regexp.MustCompile(`(?im)^\s*Baseline:\s*adopted\b`)
	trailingWS  = regexp.MustCompile(`[ \t\r]+$`)
	multiNL     = regexp.MustCompile(`\n{2,}`)
)

// Norm compares requirement text: trailing spaces and blank lines do not count.
func Norm(t string) string {
	ls := strings.Split(strings.ReplaceAll(t, "\r\n", "\n"), "\n")
	for i, l := range ls {
		ls[i] = trailingWS.ReplaceAllString(l, "")
	}
	return strings.TrimSpace(multiNL.ReplaceAllString(strings.Join(ls, "\n"), "\n"))
}

// ParseSpec reads the requirements of a living spec or a delta spec.
func ParseSpec(text string) Parsed {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var out Parsed
	op := "LIVING"
	var req *Requirement
	var fence byte
	inPurpose := false
	var purpose strings.Builder
	closeReq := func(end int) {
		if req == nil {
			return
		}
		var keep []string
		for j := req.Line - 1; j < end; j++ {
			if j != req.acceptedAt {
				keep = append(keep, lines[j])
			}
		}
		req.Block = Norm(strings.Join(keep, "\n"))
		req = nil
	}
	for i, l := range lines {
		if m := fenceRE.FindStringSubmatch(l); m != nil {
			if fence == 0 {
				fence = m[1][0]
			} else if m[1][0] == fence && m[2] == "" {
				fence = 0
			}
			continue
		}
		if fence != 0 {
			continue
		}
		if m := h2RE.FindStringSubmatch(l); m != nil {
			closeReq(i)
			inPurpose = purposeRE.MatchString(m[1])
			op = "LIVING"
			if o := opRE.FindStringSubmatch(m[1]); o != nil {
				op = strings.ToUpper(o[1])
			}
			continue
		}
		if m := reqRE.FindStringSubmatch(l); m != nil {
			closeReq(i)
			req = &Requirement{Name: m[1], Slug: spec.Slug(m[1]), Op: op, Line: i + 1, acceptedAt: -1, Scenarios: []Scenario{}}
			out.Reqs = append(out.Reqs, req)
			inPurpose = false
			continue
		}
		if op == "RENAMED" && req == nil {
			if m := renameRE.FindStringSubmatch(l); m != nil {
				out.Renames = append(out.Renames, Rename{From: m[1], To: m[2], FromSlug: spec.Slug(m[1]), ToSlug: spec.Slug(m[2])})
			}
			continue
		}
		if inPurpose {
			purpose.WriteString(l + "\n")
			continue
		}
		if req == nil {
			continue
		}
		if m := scenRE.FindStringSubmatch(l); m != nil {
			req.Scenarios = append(req.Scenarios, Scenario{Name: m[1], Slug: spec.Slug(m[1]), Line: i + 1})
			continue
		}
		if len(req.Scenarios) > 0 {
			continue
		}
		if req.Confirmed == nil {
			if m := confirmedRE.FindStringSubmatch(l); m != nil {
				req.Confirmed = new(strings.ReplaceAll(m[1], "*", ""))
				continue
			}
		}
		if req.Accepted == nil {
			if m := acceptedRE.FindStringSubmatch(l); m != nil {
				req.Accepted = new(strings.ReplaceAll(m[1], "*", ""))
				req.acceptedAt = i
				continue
			}
		}
		if req.Why == nil {
			if m := whyRE.FindStringSubmatch(l); m != nil {
				req.Why = new(strings.TrimSpace(strings.ReplaceAll(m[1], "*", "")))
			}
		}
	}
	closeReq(len(lines))
	out.Purpose = strings.TrimSpace(htmlComment.ReplaceAllString(purpose.String(), ""))
	out.Baseline = baselineRE.MatchString(out.Purpose)
	for _, r := range out.Reqs {
		r.Baseline = out.Baseline
	}
	return out
}

// SpecFile is one <capability>.md.
type SpecFile struct{ Cap, File string }

// SpecFilesOf lists <dir>/<capability>.md sorted by capability.
func SpecFilesOf(dir string) []SpecFile {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SpecFile
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") && e.Name() != "README.md" {
			out = append(out, SpecFile{strings.TrimSuffix(e.Name(), ".md"), filepath.Join(dir, e.Name())})
		}
	}
	slices.SortFunc(out, func(a, b SpecFile) int { return strings.Compare(a.Cap, b.Cap) })
	return out
}

func readIf(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// Reqs is an ordered requirement map keyed `cap/slug`.
type Reqs struct {
	keys []string
	m    map[string]*Requirement
}

// NewReqs returns an empty map.
func NewReqs() *Reqs { return &Reqs{m: map[string]*Requirement{}} }

// Get returns the requirement of key.
func (r *Reqs) Get(k string) (*Requirement, bool) { x, ok := r.m[k]; return x, ok }

// Has reports a key.
func (r *Reqs) Has(k string) bool { _, ok := r.m[k]; return ok }

// Set adds or replaces a key (a new key goes last).
func (r *Reqs) Set(k string, v *Requirement) {
	if _, ok := r.m[k]; !ok {
		r.keys = append(r.keys, k)
	}
	r.m[k] = v
}

// Delete removes a key.
func (r *Reqs) Delete(k string) {
	if _, ok := r.m[k]; ok {
		delete(r.m, k)
		r.keys = slices.DeleteFunc(r.keys, func(x string) bool { return x == k })
	}
}

// Keys in insertion order.
func (r *Reqs) Keys() []string { return slices.Clone(r.keys) }

// Len is the number of requirements.
func (r *Reqs) Len() int { return len(r.keys) }

// Living reads the living requirements of specsDir.
func Living(specsDir string) *Reqs {
	out := NewReqs()
	for _, sf := range SpecFilesOf(specsDir) {
		for _, r := range ParseSpec(readIf(sf.File)).Reqs {
			c := *r
			c.Cap, c.Key, c.File = sf.Cap, sf.Cap+"/"+r.Slug, sf.File
			out.Set(c.Key, &c)
		}
	}
	return out
}

// Delta is one capability's delta of a change.
type Delta struct {
	Cap, File string
	Parsed
}

// Deltas reads the change's delta specs.
func Deltas(changeDir string) []Delta {
	var out []Delta
	for _, sf := range SpecFilesOf(filepath.Join(changeDir, "specs")) {
		out = append(out, Delta{sf.Cap, sf.File, ParseSpec(readIf(sf.File))})
	}
	return out
}

// Effective is the living requirements with the change's delta applied (what the specs say after sync).
func Effective(specsDir, changeDir string) *Reqs {
	m := Living(specsDir)
	if changeDir == "" {
		return m
	}
	for _, d := range Deltas(changeDir) {
		for _, rn := range d.Renames {
			if old, ok := m.Get(d.Cap + "/" + rn.FromSlug); ok {
				m.Delete(old.Key)
				c := *old
				c.Name, c.Slug, c.Key = rn.To, rn.ToSlug, d.Cap+"/"+rn.ToSlug
				m.Set(c.Key, &c)
			}
		}
		for _, r := range d.Reqs {
			key := d.Cap + "/" + r.Slug
			switch r.Op {
			case "REMOVED":
				m.Delete(key)
			case "ADDED", "MODIFIED":
				c := *r
				c.Cap, c.Key, c.File = d.Cap, key, d.File
				m.Set(key, &c)
			}
		}
	}
	return m
}

func scenarioIndex(reqs *Reqs) map[string]string {
	s := map[string]string{}
	for _, k := range reqs.keys {
		r := reqs.m[k]
		for _, sc := range r.Scenarios {
			s[r.Cap+"/"+sc.Slug] = k
		}
	}
	return s
}

// Mode is the traceability level: WINGMAN_SPEC_TRACEABILITY beats the config.
func Mode(c *config.Config) string {
	if v := strings.ToLower(os.Getenv("WINGMAN_SPEC_TRACEABILITY")); v == "on" || v == "warn" || v == "off" {
		return v
	}
	if c == nil || c.Traceability == "" {
		return "on"
	}
	return c.Traceability
}

// Level reads a level: WINGMAN_SPEC_<NAME> beats the config value, def when neither is valid.
func Level(name, value, def string, allowed ...string) string {
	if v := strings.ToLower(os.Getenv("WINGMAN_SPEC_" + strings.ToUpper(name))); slices.Contains(allowed, v) {
		return v
	}
	if slices.Contains(allowed, value) {
		return value
	}
	return def
}

// Levels are the anchor levels of a config.
type Levels struct{ Placement, Guard, Fit, Stale, Evidence string }

// LevelsOf reads the anchor levels.
func LevelsOf(c *config.Config) Levels {
	if c == nil {
		c = config.Defaults()
	}
	return Levels{
		Placement: Level("anchor_placement", c.AnchorPlacement, "warn", "warn", "error", "off"),
		Guard:     Level("anchor_guard", c.AnchorGuard, "warn", "warn", "error", "off"),
		Fit:       Level("anchor_fit", c.AnchorFit, "warn", "warn", "error", "off"),
		Stale:     Level("anchor_stale", c.AnchorStale, "info", "info", "warn", "error", "off"),
		Evidence:  Level("test_evidence", c.TestEvidence, "warn", "warn", "strict", "off"),
	}
}
