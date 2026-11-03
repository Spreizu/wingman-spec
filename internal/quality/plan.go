// Package quality holds the plan and test-quality rules: task-plan size caps, the size a change's specs require,
// the planning path, invariant scenarios, edge cases, the UX checklist, accessible names, vague THEN lines,
// scenario trace tags and tests that read source files as text.
package quality

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// Finding is one lint result. Severity is error, warning or info.
type Finding struct {
	File     string `json:"file,omitempty"`
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	Fix      string `json:"fix,omitempty"`
}

// Sizes in order. XL and XXL are larger variants of L: the same artifacts and rules, a higher task cap.
var Sizes = []string{"S", "M", "L", "XL", "XXL"}

// Caps are the implementation-task caps per size.
var Caps = map[string]int{"S": 3, "M": 6, "L": 12, "XL": 20, "XXL": 30}

// Size rules (the one source of truth; the docs quote these numbers).
const (
	SMaxRequirements = 3
	SMaxCapabilities = 1
	MMaxCapabilities = 2
)

// Risks are the risk kinds a proposal may declare.
var Risks = []string{"security", "money", "data-migration", "concurrency", "public-api"}

var sizeOrder = map[string]int{"S": 0, "M": 1, "L": 2, "XL": 3, "XXL": 4}

// IsLarge reports whether size is L or one of its larger variants.
func IsLarge(size string) bool { return size != "" && sizeOrder[size] >= sizeOrder["L"] }

// SizeFor is the smallest size whose cap holds n implementation tasks (XXL beyond every cap).
func SizeFor(n int) string {
	for _, s := range Sizes {
		if n <= Caps[s] {
			return s
		}
	}
	return "XXL"
}

// PlanResult is the outcome of PlanLint.
type PlanResult struct {
	Size                string    `json:"size"`
	ImplementationTasks int       `json:"implementation_tasks"`
	ReviewTasks         int       `json:"review_tasks"`
	CloseoutTasks       int       `json:"closeout_tasks"`
	Problems            []Finding `json:"problems"`
}

// PlanOpts are the inputs of PlanLint that come from outside tasks.md.
type PlanOpts struct {
	Size   string // from proposal.md
	Review *bool  // whether a final review is required (nil: Size != S)
	Files  string // the traceability level for the Files: rule: "" or "on" an error, "warn" a warning, "off" skipped
}

var sourceTextTestFirst = regexp.MustCompile(`(?i)\?raw\b|\bas text\b|readFileSync|\bregex(es)?\b[^.]*\.(vue|css|scss|svelte)\b`)

func taskID(t *tasks.Task) string {
	if t.Label != "" {
		return t.Label
	}
	return t.Title
}

// PlanLint applies the task-plan rules to tasks.md.
func PlanLint(text string, o PlanOpts) PlanResult {
	p := tasks.Parse(text)
	var out []Finding
	if o.Size != "" {
		if p.Size != "" && p.Size != o.Size {
			out = append(out, Finding{Line: p.SizeLine, Severity: "error", Kind: "size-drift", Text: fmt.Sprintf("tasks.md says Size: %s but proposal.md says Size: %s; the size lives in proposal.md: delete the Size line from tasks.md (or make them agree)", p.Size, o.Size)})
		}
		p.Size = o.Size
		if p.SizeLine == 0 {
			p.SizeLine = 1
		}
	}
	var impl []*tasks.Task
	type rev struct {
		t *tasks.Task
		g *tasks.Group
	}
	var reviews []rev
	closeouts := 0
	for _, g := range p.Groups {
		for _, t := range g.Tasks {
			if t.Review {
				reviews = append(reviews, rev{t, g})
			}
			if t.Closeout {
				closeouts++
			}
			if !g.QA && !t.Review && !t.Closeout {
				impl = append(impl, t)
			}
		}
	}
	if p.Size == "" {
		out = append(out, Finding{Line: 1, Severity: "warning", Kind: "size", Text: fmt.Sprintf(`no "Size: S|M|L|XL|XXL" line at the top of proposal.md; caps are S <= %d, M <= %d, L <= %d, XL <= %d, XXL <= %d implementation tasks (this plan has %d)`, Caps["S"], Caps["M"], Caps["L"], Caps["XL"], Caps["XXL"], len(impl))})
	} else if need := SizeFor(len(impl)); sizeOrder[need] > sizeOrder[p.Size] {
		art := " and write the full artifacts for it"
		if IsLarge(p.Size) {
			art = " (the same artifacts as L)"
		}
		out = append(out, Finding{Line: p.SizeLine, Severity: "error", Kind: "size-cap", Text: fmt.Sprintf("Size %s allows at most %d implementation tasks; this plan has %d. Set Size: %s in proposal.md%s.", p.Size, Caps[p.Size], len(impl), need, art)})
	}
	if len(impl) > Caps["XXL"] {
		out = append(out, Finding{Line: p.SizeLine, Severity: "warning", Kind: "size-split", Text: fmt.Sprintf("%d implementation tasks, more than Size XXL's %d. Consider splitting the work into separate changes, each a working slice whose proposal names the change it depends on, so they run in order. Do not merge tasks just to fit. Lint still passes, so apply can proceed.", len(impl), Caps["XXL"])})
	}
	size := p.Size
	if size == "" {
		size = SizeFor(len(impl))
	}
	var last *tasks.Group
	if len(p.Groups) > 0 {
		last = p.Groups[len(p.Groups)-1]
	}
	var firstImpl *tasks.Group
	for _, g := range p.Groups {
		if slices.ContainsFunc(g.Tasks, func(t *tasks.Task) bool { return !t.Review && !t.Closeout }) {
			firstImpl = g
			break
		}
	}
	isFinal := func(i int) bool {
		r := reviews[i]
		return r.t.Final || (last != nil && r.g == last && i == len(reviews)-1)
	}
	for i, r := range reviews {
		if isFinal(i) {
			continue
		}
		early := IsLarge(size) && r.g == firstImpl
		if !r.g.Risky && !early {
			an := "n " + size
			extra := ""
			if IsLarge(size) {
				extra = ", the early review after group 1"
			}
			out = append(out, Finding{Line: r.t.Line, Severity: "warning", Kind: "review", Text: fmt.Sprintf(`%s: group review on a%s change. Keep one final review of the whole change%s and reviews after groups marked "(risky)" in their heading; delete this one`, taskID(r.t), an, extra)})
		}
	}
	hasFinal := false
	for i := range reviews {
		if isFinal(i) {
			hasFinal = true
		}
	}
	needReview := size != "S"
	if o.Review != nil {
		needReview = *o.Review
	}
	if len(impl) > 0 && o.Review != nil && !*o.Review && hasFinal {
		r := reviews[len(reviews)-1]
		out = append(out, Finding{Line: r.t.Line, Severity: "warning", Kind: "review", Text: fmt.Sprintf("%s: no final review on this change (Size S, Risk none, no UI); a review task is for Size M or larger, a Risk kind or a UI change. Delete it", taskID(r.t))})
	}
	if len(impl) > 0 && needReview && !hasFinal {
		line := 1
		if last != nil {
			line = last.Line
		}
		out = append(out, Finding{Line: line, Severity: "warning", Kind: "review", Text: `no final "Request code review of the whole change" task at the end (required for Size M or larger, a Risk kind or a UI change)`})
	}
	if IsLarge(size) && firstImpl != nil && len(p.Groups) > 1 && !slices.ContainsFunc(firstImpl.Tasks, func(t *tasks.Task) bool { return t.Review }) {
		out = append(out, Finding{Line: firstImpl.Line, Severity: "warning", Kind: "review", Text: fmt.Sprintf(`Size %s: end group %s (the walking skeleton) with an early "Request code review for group %s" task; it is the review that found real problems in the pilot`, size, firstImpl.N, firstImpl.N)})
	}
	for _, g := range p.Groups {
		for _, t := range g.Tasks {
			if t.Closeout {
				out = append(out, Finding{Line: t.Line, Severity: "warning", Kind: "closeout", Text: fmt.Sprintf("%s: close-out task done by `wingman-spec finish` (full tests, typecheck, lint, validate, visual, trace, source-text rule) without an agent; delete it", taskID(t))})
			}
		}
	}
	for i := 1; i < len(impl); i++ {
		a, b := impl[i-1], impl[i]
		var shared []string
		for _, f := range a.Files {
			if !testpaths.IsTestPath(f) && slices.Contains(b.Files, f) {
				shared = append(shared, f)
			}
		}
		if len(shared) > 0 {
			out = append(out, Finding{Line: b.Line, Severity: "warning", Kind: "merge", Text: fmt.Sprintf("%s and %s both change %s: merge them into one task unless the test-first step differs in kind (e.g. a unit test vs a DOM/visual check)", a.Label, b.Label, strings.Join(shared, ", "))})
		}
	}
	if size != "S" {
		out = append(out, serialGroups(p)...)
	}
	out = append(out, idLint(p, impl, o.Files)...)
	for _, t := range impl {
		if sourceTextTestFirst.MatchString(t.Details["test first"]) {
			out = append(out, Finding{Line: t.Line, Severity: "warning", Kind: "source-text", Text: t.Label + ": Test first reads source code as text; test the rendered behaviour instead and put layout in a ```visual scenario (the verifier rejects source-text tests)"})
		}
	}
	return PlanResult{Size: p.Size, ImplementationTasks: len(impl), ReviewTasks: len(reviews), CloseoutTasks: closeouts, Problems: out}
}

// idLint: task labels are unique, every After: names a known earlier label, and every implementation task lists its
// Files: (the waves and the scope check read them; traceability off drops that rule, warn makes it a warning).
func idLint(p *tasks.Plan, impl []*tasks.Task, files string) []Finding {
	var out []Finding
	seen := map[string]int{}
	for _, t := range p.All() {
		if t.Label == "" {
			continue
		}
		if first, ok := seen[t.Label]; ok {
			out = append(out, Finding{Line: t.Line, Severity: "error", Kind: "task-id", Text: fmt.Sprintf("task label %s is used twice (first on line %d): number the tasks uniquely", t.Label, first)})
			continue
		}
		seen[t.Label] = t.Line
	}
	for _, t := range p.All() {
		for _, a := range t.After() {
			switch first, ok := seen[a]; {
			case a == t.Label:
				out = append(out, Finding{Line: t.Line, Severity: "error", Kind: "task-after", Text: fmt.Sprintf("%s: After: names the task itself", taskID(t))})
			case !ok:
				out = append(out, Finding{Line: t.Line, Severity: "error", Kind: "task-after", Text: fmt.Sprintf("%s: After: names %s, which is no task label of this plan", taskID(t), a)})
			case first > t.Line:
				out = append(out, Finding{Line: t.Line, Severity: "error", Kind: "task-after", Text: fmt.Sprintf("%s: After: names %s, which comes later in the plan: a task can only wait for an earlier one", taskID(t), a)})
			}
		}
	}
	sev := map[string]string{"": "error", "on": "error", "warn": "warning"}[files]
	for _, t := range impl {
		if len(t.Files) == 0 && sev != "" {
			out = append(out, Finding{Line: t.Line, Severity: sev, Kind: "task-files", Text: fmt.Sprintf("%s: no `Files:` line: list the files the task creates or changes", taskID(t))})
		}
	}
	return out
}

// serialGroups warns about a group of three or more implementation tasks where no two can run in the same parallel
// wave (every pair shares a non-test file or one waits for the other with After:).
func serialGroups(p *tasks.Plan) []Finding {
	var out []Finding
	for _, g := range p.Groups {
		var ts []*tasks.Task
		for _, t := range g.Tasks {
			if !t.Review && !t.Closeout && len(t.Files) > 0 {
				ts = append(ts, t)
			}
		}
		if len(ts) < 3 || slices.ContainsFunc(ts, func(a *tasks.Task) bool {
			return slices.ContainsFunc(ts, func(b *tasks.Task) bool { return a != b && disjoint(a, b) })
		}) {
			continue
		}
		out = append(out, Finding{Line: g.Line, Severity: "warning", Kind: "parallel", Text: fmt.Sprintf("group %s: its %d tasks all share files (or wait for each other), so none of them can run in parallel; split the work by file (one task per module or component) where the tasks are independent", g.N, len(ts))})
	}
	return out
}

func disjoint(a, b *tasks.Task) bool {
	if slices.Contains(a.After(), b.Label) || slices.Contains(b.After(), a.Label) {
		return false
	}
	for _, f := range a.Files {
		if !testpaths.IsTestPath(f) && slices.Contains(b.Files, f) {
			return false
		}
	}
	return true
}

var (
	commentBlock = regexp.MustCompile(`(?s)<!--.*?-->`)
	propSizeRE   = regexp.MustCompile(`(?i)^\s*(?:[-*]\s+)?\**Size\**:\s*\**\s*(XXL|XL|[SML])\b`)
	propRiskRE   = regexp.MustCompile(`(?i)^\s*(?:[-*]\s+)?\**Risk\**:\s*\**\s*(.*?)\s*$`)
	riskNoneRE   = regexp.MustCompile(`^(none|no|-|n/a)?$`)
	riskSplitRE  = regexp.MustCompile(`\s*[,;/]\s*|\s+and\s+`)
	spaceRE      = regexp.MustCompile(`\s+`)
	h2RE         = regexp.MustCompile(`^##\s`)
)

// StripComments blanks HTML comments, keeping the line count.
func StripComments(t string) string {
	return commentBlock.ReplaceAllStringFunc(t, func(m string) string {
		return strings.Repeat("\n", strings.Count(m, "\n"))
	})
}

// ProposalSize is the `Size:` and `Risk:` lines of proposal.md. Risk is nil when there is no Risk line.
type ProposalSize struct {
	Size     string   `json:"size"`
	Line     int      `json:"line"`
	Risk     []string `json:"risk"`
	RiskLine int      `json:"risk_line"`
}

// ReadProposalSize reads the first `Size:` and `Risk:` lines of proposal.md (comments ignored).
func ReadProposalSize(text string) ProposalSize {
	var out ProposalSize
	riskSeen := false
	for i, l := range strings.Split(strings.ReplaceAll(StripComments(text), "\r\n", "\n"), "\n") {
		if out.Size == "" {
			if m := propSizeRE.FindStringSubmatch(l); m != nil {
				out.Size, out.Line = strings.ToUpper(m[1]), i+1
			}
		}
		if !riskSeen {
			if m := propRiskRE.FindStringSubmatch(l); m != nil {
				riskSeen = true
				v := strings.ToLower(strings.TrimSpace(strings.NewReplacer("`", "", "*", "").Replace(m[1])))
				out.Risk = []string{}
				if !riskNoneRE.MatchString(v) {
					for _, x := range riskSplitRE.Split(v, -1) {
						if x = spaceRE.ReplaceAllString(strings.TrimSpace(x), "-"); x != "" {
							out.Risk = append(out.Risk, x)
						}
					}
				}
				out.RiskLine = i + 1
			}
		}
	}
	return out
}

// Section returns the body of the `## <name>` sections whose heading matches re.
func Section(text string, re *regexp.Regexp) string {
	var out []string
	on := false
	for l := range strings.SplitSeq(text, "\n") {
		if h2RE.MatchString(l) {
			on = re.MatchString(strings.TrimSpace(strings.TrimPrefix(l, "##")))
			continue
		}
		if on {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

var (
	fmRE     = regexp.MustCompile(`^---\r?\n((?s:.*?))\r?\n---`)
	statusRE = regexp.MustCompile(`(?im)^status:[ \t]*(.*)$`)
)

// IsNoneADR reports whether an ADR file is the "no architectural decision" record (none.md or `status: none`).
func IsNoneADR(fileName, text string) bool {
	if strings.EqualFold(fileName, "none.md") {
		return true
	}
	m := fmRE.FindStringSubmatch(text)
	if m == nil {
		return false
	}
	s := statusRE.FindStringSubmatch(m[1])
	if s == nil {
		return false
	}
	return strings.ToLower(strings.Trim(strings.TrimSpace(s[1]), `"'`)) == "none"
}

func readIf(f string) (string, bool) {
	b, err := os.ReadFile(f)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// SpecFile is one spec file of a specs directory: <dir>/<capability>.md.
type SpecFile struct {
	Cap  string
	File string
}

// SpecFiles lists <dir>/<capability>.md, sorted by capability.
func SpecFiles(dir string) []SpecFile {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SpecFile
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".md") || strings.HasPrefix(n, ".") || strings.EqualFold(n, "README.md") {
			continue
		}
		out = append(out, SpecFile{strings.TrimSuffix(n, ".md"), filepath.Join(dir, n)})
	}
	return out
}
