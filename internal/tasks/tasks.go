// Package tasks parses tasks.md: groups (`## N. Title`), checkbox tasks (`- [ ] N.M title`) and their indented
// detail lines (`Spec:`, `Test first:`, `Files:`, `Visual:`, `Done when:`, `After:`).
package tasks

import (
	"regexp"
	"strconv"
	"strings"
)

// Group is a `## N. Title` section.
type Group struct {
	N        string  `json:"n"`
	Title    string  `json:"title"`
	QA       bool    `json:"qa,omitempty"`
	Risky    bool    `json:"risky,omitempty"`
	Closeout bool    `json:"closeout,omitempty"`
	Line     int     `json:"line"`
	Tasks    []*Task `json:"tasks"`
}

// Task is one checkbox line and its details.
type Task struct {
	Label    string            `json:"label"` // "1.2", "2.R" or "" when unnumbered
	Title    string            `json:"title"`
	Line     int               `json:"line"`
	Done     bool              `json:"done"`
	Details  map[string]string `json:"details"` // lower-case key -> value of the first line with that key
	Detail   []string          `json:"-"`       // every indented detail line, bullet removed, in order
	Review   bool              `json:"review,omitempty"`
	Closeout bool              `json:"closeout,omitempty"`
	Final    bool              `json:"final,omitempty"`
	Files    []string          `json:"files"`
	Group    *Group            `json:"-"`
}

// Plan is a parsed tasks.md.
type Plan struct {
	Size     string   `json:"size,omitempty"`
	SizeLine int      `json:"size_line,omitempty"`
	Groups   []*Group `json:"groups"`
}

var (
	taskRE     = regexp.MustCompile(`^[-*+]\s+\[([ xX])\]\s+(?:(\d+\.(?:\d+|[A-Za-z]+))\s+)?(.*?)\s*$`)
	reviewRE   = regexp.MustCompile(`(?i)\bcode review\b|\breview\b.*\b(group|change)\b`)
	closeoutRE = regexp.MustCompile(`(?i)full (test )?suite|wingman-spec validate|openspec validate|validation passes|every (spec )?scenario is covered|every visual scenario passes|visual check and review`)
	sizeRE     = regexp.MustCompile(`(?i)^\s*(?:[-*]\s+)?\**Size\**:\s*\**\s*([SML])\b`)
	groupRE    = regexp.MustCompile(`^##\s+(?:(\d+)\.\s*)?(.*?)\s*$`)
	detailRE   = regexp.MustCompile(`^\s+[-*+]\s+([A-Za-z ]+):\s*(.*)$`)
	commentRE  = regexp.MustCompile(`<!--.*?-->`)
	fenceRE    = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	riskyRE    = regexp.MustCompile(`(?i)\(risky\)|\brisky\b`)
	qaRE       = regexp.MustCompile(`(?i)^qa[ -]?fix`)
	closeGrpRE = regexp.MustCompile(`(?i)^close-?out\b`)
	finalRE    = regexp.MustCompile(`(?i)final|whole change|entire change`)
	reviewLbl  = regexp.MustCompile(`(?i)\.R$`)
	fileSplit  = regexp.MustCompile(`[\s,;]+`)
	checkboxRE = regexp.MustCompile(`^\s*[-*+]\s+\[[ xX]\]\s`)
)

// IsReview reports whether a task is a review task (label N.R, or a title asking for a code review).
func IsReview(label, title string) bool {
	return reviewLbl.MatchString(label) || reviewRE.MatchString(title)
}

// IsQAGroup reports whether a group title is a `QA fix` group added by /spec-fix.
func IsQAGroup(title string) bool { return qaRE.MatchString(title) }

// IsCloseoutGroup reports whether a group title is a close-out group.
func IsCloseoutGroup(title string) bool { return closeGrpRE.MatchString(title) }

// IsCloseoutTitle reports whether a task title describes close-out work that `finish` does.
func IsCloseoutTitle(title string) bool { return closeoutRE.MatchString(title) }

// Parse parses tasks.md.
func Parse(text string) *Plan {
	p := &Plan{}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var g *Group
	var t *Task
	fence := false
	detailDone := false // Detail stops at the first blank line after a detail, like a reader would
	for i, l := range lines {
		n := i + 1
		if fenceRE.MatchString(l) {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		if p.Size == "" {
			if m := sizeRE.FindStringSubmatch(l); m != nil {
				p.Size, p.SizeLine = strings.ToUpper(m[1]), n
				continue
			}
		}
		if m := groupRE.FindStringSubmatch(l); m != nil && !strings.HasPrefix(l, "###") {
			title := strings.TrimSpace(commentRE.ReplaceAllString(m[2], ""))
			num := m[1]
			if num == "" {
				num = strconv.Itoa(len(p.Groups) + 1)
			}
			g = &Group{N: num, Title: title, QA: IsQAGroup(title), Risky: riskyRE.MatchString(title), Closeout: IsCloseoutGroup(title), Line: n}
			p.Groups = append(p.Groups, g)
			t = nil
			continue
		}
		if m := taskRE.FindStringSubmatch(l); m != nil {
			if g == nil {
				g = &Group{N: "1", Title: "Tasks", Line: n}
				p.Groups = append(p.Groups, g)
			}
			title := strings.TrimSpace(commentRE.ReplaceAllString(m[3], ""))
			t = &Task{Label: m[2], Title: title, Line: n, Done: m[1] != " ", Details: map[string]string{}, Group: g}
			t.Review = IsReview(t.Label, title)
			t.Closeout = !t.Review && (g.Closeout || IsCloseoutTitle(title))
			g.Tasks = append(g.Tasks, t)
			detailDone = false
			continue
		}
		if t != nil {
			if m := detailRE.FindStringSubmatch(l); m != nil {
				k := strings.ToLower(strings.TrimSpace(m[1]))
				if _, seen := t.Details[k]; !seen {
					t.Details[k] = strings.TrimSpace(m[2])
				}
				if !detailDone {
					t.Detail = append(t.Detail, strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "-*+ ")))
				}
				continue
			}
			if strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t") {
				if s := strings.TrimSpace(l); s != "" && !checkboxRE.MatchString(l) && !detailDone {
					t.Detail = append(t.Detail, strings.TrimLeft(s, "-*+ "))
				}
				continue
			}
			if l == "" {
				detailDone = detailDone || len(t.Detail) > 0
				continue
			}
			t = nil
		}
	}
	for _, gr := range p.Groups {
		for _, x := range gr.Tasks {
			x.Files = FileList(x.Details["files"])
			x.Final = x.Review && finalRE.MatchString(x.Title)
		}
	}
	return p
}

// FileList splits a `Files:` value into paths (words with a dot or a slash).
func FileList(v string) []string {
	var out []string
	for _, f := range fileSplit.Split(v, -1) {
		f = strings.NewReplacer("`", "", "(", "", ")", "").Replace(f)
		if strings.ContainsAny(f, "./") {
			out = append(out, f)
		}
	}
	return out
}

// All returns every task in file order.
func (p *Plan) All() []*Task {
	var out []*Task
	for _, g := range p.Groups {
		out = append(out, g.Tasks...)
	}
	return out
}

// DoneWhen returns the `Done when:` line and its first backticked command.
func (t *Task) DoneWhen() (line, cmd string) {
	for _, d := range t.Detail {
		if len(d) >= 10 && strings.EqualFold(d[:10], "done when:") {
			if _, rest, ok := strings.Cut(d, "`"); ok {
				if c, _, ok := strings.Cut(rest, "`"); ok {
					return d, c
				}
			}
			return d, ""
		}
	}
	return "", ""
}

// After returns the labels a task names in an `After:` line (parallel waves).
func (t *Task) After() []string {
	var out []string
	for _, f := range fileSplit.Split(t.Details["after"], -1) {
		if f = strings.Trim(f, "`"); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// Ambiguous is a checkbox line a reader could miscount: inside a code fence, or nested under another item.
type Ambiguous struct {
	Line int    `json:"line"`
	Kind string `json:"kind"` // fenced | nested
	Text string `json:"text"`
}

// AmbiguousLines lists checkbox lines inside fences or nested under another item.
func AmbiguousLines(text string) []Ambiguous {
	var out []Ambiguous
	var fence byte
	for i, l := range strings.Split(text, "\n") {
		if m := fenceRE.FindStringSubmatch(l); m != nil {
			switch {
			case fence == 0:
				fence = m[1][0]
			case m[1][0] == fence:
				fence = 0
			}
			continue
		}
		if !checkboxRE.MatchString(l) {
			continue
		}
		switch {
		case fence != 0:
			out = append(out, Ambiguous{i + 1, "fenced", strings.TrimSpace(l)})
		case strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t"):
			out = append(out, Ambiguous{i + 1, "nested", strings.TrimSpace(l)})
		}
	}
	return out
}
