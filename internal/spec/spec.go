// Package spec parses living specs and delta specs and merges a delta into a living spec.
//
// A living spec (specs/<capability>.md):
//
//	# <capability>
//
//	## Purpose
//	<paragraph>
//
//	## Requirements
//
//	### Requirement: <name>
//	The system SHALL ...
//
//	#### Scenario: <name>
//	- **WHEN** ...
//	- **THEN** ...
//
// A delta spec (changes/<change>/specs/<capability>.md) has the sections ## ADDED, ## MODIFIED,
// ## REMOVED and ## RENAMED, and ## Purpose for a new capability.
package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// Requirement is one `### Requirement:` block.
type Requirement struct {
	Name      string     `json:"name"`
	Line      int        `json:"line"` // 1-based line of the heading
	Text      string     `json:"-"`    // the whole block, heading included, without trailing blank lines
	Scenarios []Scenario `json:"scenarios"`
}

// Scenario is one `#### Scenario:` block of a requirement.
type Scenario struct {
	Name string `json:"name"`
	Line int    `json:"line"`
	Text string `json:"-"`
}

// Rename is one line of a ## RENAMED section: `- Old name -> New name`.
type Rename struct {
	From string `json:"from"`
	To   string `json:"to"`
	Line int    `json:"line"`
}

// Problem is a parse finding with its 1-based line.
type Problem struct {
	Line int    `json:"line"`
	Msg  string `json:"message"`
}

func (p Problem) String() string { return fmt.Sprintf("line %d: %s", p.Line, p.Msg) }

// Delta operations, in merge order.
const (
	OpRenamed  = "RENAMED"
	OpRemoved  = "REMOVED"
	OpModified = "MODIFIED"
	OpAdded    = "ADDED"
)

// Delta is a parsed delta spec.
type Delta struct {
	Purpose  string        `json:"purpose,omitempty"`
	Added    []Requirement `json:"added"`
	Modified []Requirement `json:"modified"`
	Removed  []Requirement `json:"removed"`
	Renamed  []Rename      `json:"renamed"`
	Problems []Problem     `json:"problems,omitempty"`
}

// Empty reports whether the delta changes nothing.
func (d *Delta) Empty() bool {
	return len(d.Added)+len(d.Modified)+len(d.Removed)+len(d.Renamed) == 0
}

// Living is a parsed living spec. Prelude and Tail are kept byte for byte so a merge only touches the requirements.
type Living struct {
	Title        string        `json:"title"`
	Purpose      string        `json:"purpose"`
	Requirements []Requirement `json:"requirements"`
	Prelude      string        `json:"-"` // everything before the ## Requirements heading
	Tail         string        `json:"-"` // level-2 sections after the requirements
	Problems     []Problem     `json:"problems,omitempty"`
}

var (
	reqHeading      = regexp.MustCompile(`^###\s+Requirement:\s*(.*?)\s*$`)
	scenarioHeading = regexp.MustCompile(`^####\s+Scenario:\s*(.*?)\s*$`)
	wrongScenario   = regexp.MustCompile(`^(#{1,3}|#{5,})\s+Scenario:`)
	fenceLine       = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	h2              = regexp.MustCompile(`^##\s+(.*?)\s*$`)
	h1              = regexp.MustCompile(`^#\s+(.*?)\s*$`)
	renameLine      = regexp.MustCompile(`^[-*]\s+(.+?)\s*->\s*(.+?)\s*$`)
)

// line is one source line with its fence state.
type line struct {
	text    string
	n       int  // 1-based
	inFence bool // inside a code fence (fence lines themselves count as inside)
}

func scan(src string) []line {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	raw := strings.Split(strings.TrimSuffix(src, "\n"), "\n")
	out := make([]line, len(raw))
	var fence byte
	for i, t := range raw {
		m := fenceLine.FindStringSubmatch(t)
		switch {
		case m != nil && fence == 0:
			fence = m[1][0]
			out[i] = line{t, i + 1, true}
		case m != nil && m[1][0] == fence:
			fence = 0
			out[i] = line{t, i + 1, true}
		default:
			out[i] = line{t, i + 1, fence != 0}
		}
	}
	return out
}

// section is a level-2 section: its heading text and lines (heading excluded).
type section struct {
	heading string
	line    int
	lines   []line
}

// sections splits lines at level-2 headings outside fences. The first section (before any ## heading) has heading "".
func sections(ls []line) []section {
	out := []section{{}}
	for _, l := range ls {
		if !l.inFence {
			if m := h2.FindStringSubmatch(l.text); m != nil && !strings.HasPrefix(l.text, "###") {
				out = append(out, section{heading: m[1], line: l.n})
				continue
			}
		}
		out[len(out)-1].lines = append(out[len(out)-1].lines, l)
	}
	return out
}

// requirements reads the `### Requirement:` blocks of a section. Text before the first block is reported.
func requirements(ls []line, problems *[]Problem) []Requirement {
	var out []Requirement
	var cur *Requirement
	var body []string
	flush := func() {
		if cur == nil {
			return
		}
		cur.Text = strings.TrimRight(strings.Join(body, "\n"), "\n \t")
		cur.Scenarios = scenarios(cur.Text, cur.Line)
		out = append(out, *cur)
		cur, body = nil, nil
	}
	quiet := false // one report per stray stretch of text
	for _, l := range ls {
		if !l.inFence {
			if m := reqHeading.FindStringSubmatch(l.text); m != nil {
				flush()
				quiet = false
				cur = &Requirement{Name: m[1], Line: l.n}
				if m[1] == "" {
					*problems = append(*problems, Problem{l.n, "requirement heading without a name"})
				}
				body = []string{l.text}
				continue
			}
			if wrongScenario.MatchString(l.text) {
				*problems = append(*problems, Problem{l.n, "a scenario heading has exactly four #: `#### Scenario: <name>`"})
				if cur != nil {
					body = append(body, l.text)
				}
				continue
			}
			if strings.HasPrefix(l.text, "### ") {
				flush()
				quiet = true
				*problems = append(*problems, Problem{l.n, fmt.Sprintf("unexpected heading %q: a requirement starts with `### Requirement: <name>`", strings.TrimSpace(l.text))})
				continue
			}
		}
		if cur == nil {
			if strings.TrimSpace(l.text) != "" && !isComment(l.text) && !quiet {
				*problems = append(*problems, Problem{l.n, "text outside a requirement block"})
				quiet = true
			}
			continue
		}
		body = append(body, l.text)
	}
	flush()
	return out
}

func isComment(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "<!--") && strings.HasSuffix(s, "-->")
}

func scenarios(block string, first int) []Scenario {
	var out []Scenario
	var cur *Scenario
	var body []string
	flush := func() {
		if cur != nil {
			cur.Text = strings.TrimRight(strings.Join(body, "\n"), "\n \t")
			out = append(out, *cur)
		}
		cur, body = nil, nil
	}
	for _, l := range scan(block) {
		if !l.inFence {
			if m := scenarioHeading.FindStringSubmatch(l.text); m != nil {
				flush()
				cur = &Scenario{Name: m[1], Line: first + l.n - 1}
				body = []string{l.text}
				continue
			}
		}
		if cur != nil {
			body = append(body, l.text)
		}
	}
	flush()
	return out
}

// ParseDelta parses a delta spec.
func ParseDelta(src string) *Delta {
	d := &Delta{}
	for _, s := range sections(scan(src)) {
		switch op := deltaOp(s.heading); {
		case s.heading == "":
			for _, l := range s.lines {
				t := strings.TrimSpace(l.text)
				if t != "" && !isComment(t) && !h1.MatchString(t) {
					d.Problems = append(d.Problems, Problem{l.n, "text before the first ## section"})
				}
			}
		case s.heading == "Purpose":
			d.Purpose = paragraph(s.lines)
		case op == OpAdded:
			d.Added = append(d.Added, requirements(s.lines, &d.Problems)...)
		case op == OpModified:
			d.Modified = append(d.Modified, requirements(s.lines, &d.Problems)...)
		case op == OpRemoved:
			d.Removed = append(d.Removed, requirements(s.lines, &d.Problems)...)
		case op == OpRenamed:
			d.Renamed = append(d.Renamed, renames(s.lines, &d.Problems)...)
		case legacyOp(s.heading) != "":
			d.Problems = append(d.Problems, Problem{s.line, fmt.Sprintf("`## %s`: write `## %s` (run `wingman-spec import openspec` to convert old files)", s.heading, legacyOp(s.heading))})
		default:
			d.Problems = append(d.Problems, Problem{s.line, fmt.Sprintf("unknown section `## %s`: a delta has ## ADDED, ## MODIFIED, ## REMOVED, ## RENAMED (and ## Purpose for a new capability)", s.heading)})
		}
	}
	return d
}

func deltaOp(h string) string {
	switch h {
	case OpAdded, OpModified, OpRemoved, OpRenamed:
		return h
	}
	return ""
}

// legacyOp maps an OpenSpec heading such as "ADDED Requirements" to its short form.
func legacyOp(h string) string {
	op, rest, ok := strings.Cut(h, " ")
	if ok && strings.EqualFold(strings.TrimSpace(rest), "Requirements") && deltaOp(op) != "" {
		return op
	}
	return ""
}

func renames(ls []line, problems *[]Problem) []Rename {
	var out []Rename
	for _, l := range ls {
		t := strings.TrimSpace(l.text)
		if t == "" || isComment(t) {
			continue
		}
		m := renameLine.FindStringSubmatch(t)
		if m == nil || strings.Contains(m[2], "->") {
			*problems = append(*problems, Problem{l.n, "a RENAMED line is `- <old name> -> <new name>`"})
			continue
		}
		out = append(out, Rename{From: m[1], To: m[2], Line: l.n})
	}
	return out
}

func paragraph(ls []line) string {
	var parts []string
	for _, l := range ls {
		if t := strings.TrimSpace(l.text); t != "" && !isComment(t) {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

// ParseLiving parses a living spec.
func ParseLiving(src string) *Living {
	sp := &Living{}
	ls := scan(src)
	reqAt := -1
	for i, l := range ls {
		if !l.inFence && h2.MatchString(l.text) && strings.TrimSpace(strings.TrimPrefix(l.text, "##")) == "Requirements" {
			reqAt = i
			break
		}
	}
	for _, l := range ls {
		if m := h1.FindStringSubmatch(l.text); m != nil && !l.inFence {
			sp.Title = m[1]
			break
		}
	}
	for _, s := range sections(ls) {
		if s.heading == "Purpose" {
			sp.Purpose = paragraph(s.lines)
		}
	}
	if reqAt < 0 {
		sp.Prelude = strings.TrimRight(src, "\n \t")
		sp.Problems = append(sp.Problems, Problem{1, "no `## Requirements` section"})
		return sp
	}
	sp.Prelude = strings.TrimRight(joinText(ls[:reqAt]), "\n \t")
	end := len(ls)
	for i := reqAt + 1; i < len(ls); i++ {
		if !ls[i].inFence && h2.MatchString(ls[i].text) && !strings.HasPrefix(ls[i].text, "###") {
			end = i
			break
		}
	}
	sp.Requirements = requirements(ls[reqAt+1:end], &sp.Problems)
	sp.Tail = strings.TrimRight(joinText(ls[end:]), "\n \t")
	return sp
}

func joinText(ls []line) string {
	parts := make([]string, len(ls))
	for i, l := range ls {
		parts[i] = l.text
	}
	return strings.Join(parts, "\n")
}

// Render writes a living spec back to text.
func (sp *Living) Render() string {
	var b strings.Builder
	b.WriteString(sp.Prelude)
	b.WriteString("\n\n## Requirements\n")
	for _, r := range sp.Requirements {
		b.WriteString("\n")
		b.WriteString(r.Text)
		b.WriteString("\n")
	}
	if sp.Tail != "" {
		b.WriteString("\n")
		b.WriteString(sp.Tail)
		b.WriteString("\n")
	}
	return b.String()
}

// Key normalises a requirement name for comparison: case-insensitive, whitespace collapsed.
func Key(name string) string { return strings.ToLower(strings.Join(strings.Fields(name), " ")) }

// Slug is the anchor slug of a requirement or scenario name: lower case, runs of other characters as one dash.
func Slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
			continue
		}
		dash = true
	}
	if b.Len() == 0 {
		return "scenario"
	}
	return b.String()
}
