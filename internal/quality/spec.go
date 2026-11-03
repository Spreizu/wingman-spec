package quality

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/spec"
)

// ---------- invariant scenarios ----------

var (
	transformRE   = w(`calculat(?:e|es|ed|ing|ion|ions)|comput(?:e|es|ed|ing|ation)|appl(?:y|ies|ied|ying)|transform(?:s|ed|ing)?|convert(?:s|ed|ing)?|sort(?:s|ed|ing)?|merg(?:e|es|ed|ing)|round(?:s|ed|ing)|normali[sz](?:e|es|ed|ing)|pars(?:e|es|ed|ing)|seriali[sz](?:e|es|ed|ing)|stor(?:e|es|ed|ing)|sav(?:e|es|ed|ing)|persist(?:s|ed|ing)?|deduplicat(?:e|es|ed|ing)|aggregat(?:e|es|ed|ing)`)
	weakRE        = w(`totals?|sums?|filter(?:s|ed|ing)?|discount(?:s|ed|ing)?`)
	displayRE     = w(`show(?:s|n|ing)?|print(?:s|ed|ing)?|display(?:s|ed|ing)?|render(?:s|ed|ing)?|label(?:s|led|ed)?|visible|reads?|announce(?:s|d)?|heading|button|badge|link|icon|dialog|panel|banner|message|tooltip|focus(?:es|ed)?`)
	invariantName = regexp.MustCompile(`(?i)^invariant\b|\b(unchanged|not (?:be )?(?:mutated|modified|changed)|unmodified|immutab\w*|idempot\w*|determinis\w*|same result|shares? no)\b`)
	fenceRE       = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	reqNameRE     = regexp.MustCompile(`^###\s+Requirement:\s*(.*?)\s*$`)
	scenNameRE    = regexp.MustCompile(`^####\s+Scenario:\s*(.*?)\s*$`)
)

// transformWord is the keyword that makes a requirement data-transforming, or "" (display-only UI or no keyword).
func transformWord(stmt string) string {
	t := prose(stmt)
	if s := transformRE.find(t); s != "" {
		return s
	}
	if s := weakRE.find(t); s != "" && !displayRE.match(t) {
		return s
	}
	return ""
}

func lines(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
}

// InvariantLint lists the ADDED/MODIFIED requirements whose statement transforms or stores data but that have no invariant scenario.
func InvariantLint(specsDir string) []Finding {
	var out []Finding
	for _, sf := range SpecFiles(specsDir) {
		type req struct {
			name, sec, stmt string
			line            int
			scen            []string
			inScen          bool
		}
		var cur *req
		sec := ""
		fence := false
		flush := func() {
			if cur != nil && addModRE.MatchString(cur.sec) {
				if word := transformWord(cur.stmt); word != "" && !slices.ContainsFunc(cur.scen, invariantName.MatchString) {
					out = append(out, Finding{File: sf.File, Line: cur.line, Severity: "warning", Kind: "invariant", Text: fmt.Sprintf(`specs/%s.md:%d: requirement "%s" says "%s" (it computes, transforms or stores data) but has no invariant scenario: add "#### Scenario: Invariant: <what always holds>" (input not modified and sharing no mutable objects with the result, same input -> same result, order, rounding), or ignore this if it only displays data`, sf.Cap, cur.line, cur.name, word)})
				}
			}
			cur = nil
		}
		for i, l := range lines(sf.File) {
			if fenceRE.MatchString(l) {
				fence = !fence
				continue
			}
			if fence {
				continue
			}
			if m := h2CapRE.FindStringSubmatch(l); m != nil {
				flush()
				sec = m[1]
				continue
			}
			if m := reqNameRE.FindStringSubmatch(l); m != nil {
				flush()
				cur = &req{name: m[1], line: i + 1, sec: sec}
				continue
			}
			if cur == nil {
				continue
			}
			if m := scenNameRE.FindStringSubmatch(l); m != nil {
				cur.scen = append(cur.scen, m[1])
				cur.inScen = true
				continue
			}
			if !cur.inScen {
				cur.stmt += " " + l
			}
		}
		flush()
	}
	return out
}

// ---------- scenarios ----------

// Scenario is one scenario of a specs directory.
type Scenario struct {
	ID          string `json:"id"`
	Capability  string `json:"capability"`
	Requirement string `json:"requirement"`
	Name        string `json:"name"`
	File        string `json:"file"`
	Line        int    `json:"line"`
	Visual      bool   `json:"visual"`
	NotVisual   string `json:"not_visual,omitempty"` // the reason of a `Not visual: <reason>` line
	Shows       bool   `json:"-"`                    // a THEN/AND line names a [data-testid] element
	Text        string `json:"-"`                    // the name and the WHEN/THEN lines
}

var (
	notVisualRE = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?(?:\*\*)?not visual:?(?:\*\*)?:?\s*(\S.*)$`)
	thenTestID  = regexp.MustCompile(`^\s*-\s*\*\*(?:THEN|AND)\*\*.*\[data-testid=`)
)

var removedRenamedRE = regexp.MustCompile(`(?i)^(REMOVED|RENAMED)\b`)

// SpecScenarios lists the scenarios in <dir>/<capability>.md (REMOVED/RENAMED sections skipped).
func SpecScenarios(dir string) []*Scenario {
	var out []*Scenario
	for _, sf := range SpecFiles(dir) {
		section, req := "", ""
		var cur *Scenario
		fence := byte(0)
		for i, l := range lines(sf.File) {
			if m := fenceOpenRE.FindStringSubmatch(l); m != nil {
				if fence == 0 {
					fence = m[1][0]
					if cur != nil && isVisual(m[2]) {
						cur.Visual = true
					}
				} else if m[1][0] == fence && m[2] == "" {
					fence = 0
				}
				continue
			}
			if fence != 0 {
				continue
			}
			if m := h2CapRE.FindStringSubmatch(l); m != nil {
				section, req, cur = m[1], "", nil
				continue
			}
			if m := reqNameRE.FindStringSubmatch(l); m != nil {
				req, cur = m[1], nil
				continue
			}
			if m := scenNameRE.FindStringSubmatch(l); m != nil {
				if removedRenamedRE.MatchString(section) {
					cur = nil
					continue
				}
				cur = &Scenario{ID: sf.Cap + "/" + spec.Slug(m[1]), Capability: sf.Cap, Requirement: req, Name: m[1], File: sf.File, Line: i + 1, Text: m[1]}
				out = append(out, cur)
			} else if cur != nil {
				if m := notVisualRE.FindStringSubmatch(l); m != nil {
					cur.NotVisual = m[1]
				}
				cur.Shows = cur.Shows || thenTestID.MatchString(l)
				if m := gwtLineRE.FindStringSubmatch(l); m != nil {
					cur.Text += "\n" + m[1]
				}
			}
		}
	}
	return out
}

const dataStateHint = "Never delete a scenario or its ```visual block: when the live app lacks the data, reach the state with `do:` steps, seed data in `visual.command`, a test role in `visual.roles` or a route, and say which in design.md. `Not visual: <reason>; covered by <test>` is only for a case that is not about layout"

var (
	layoutRE   = regexp.MustCompile(`(?i)\b(?:narrow|small screens?|375\s*(?:px)?|(?:mobile|phone)\s+(?:widths?|screens?|views?|viewports?|layouts?)|overflow\w*|sideways|horizontal(?:ly)?\s+scroll\w*|wrap(?:s|ped|ping)?|truncat\w*|ellipsis)\b`)
	volumeRE   = regexp.MustCompile(`(?i)\blong(?:er|est)?\s+(?:\w+\s+){0,2}?(?:names?|titles?|texts?|labels?|words?|translations?|strings?|values?|descriptions?|content|emails?|addresses|urls?|lines?|lists?)\b|\b(?:many|lots\s+of|several|hundreds\s+of|dozens\s+of)\s+(\w+)`)
	notCountRE = regexp.MustCompile(`(?i)^(?:attempts?|times|tries|requests?|retries|calls?|failed|wrong|invalid|logins?|seconds|minutes)$`)
	rejectRE   = regexp.MustCompile(`(?i)\b(?:reject\w*|refus\w*|denied|invalid|too\s+(?:long|many)|not\s+saved|limit\w*)\b`)
)

// layoutCase is the words that make a scenario about layout (a narrow screen, long text, many rows), or "". A long or
// many case whose THEN rejects the input (a length or rate limit) is logic, not layout.
func layoutCase(text string) string {
	t := prose(text)
	if m := layoutRE.FindString(t); m != "" {
		return m
	}
	if rejectRE.MatchString(t) {
		return ""
	}
	for _, m := range volumeRE.FindAllStringSubmatch(t, -1) {
		if m[1] == "" || !notCountRE.MatchString(m[1]) {
			return m[0]
		}
	}
	return ""
}

// VisualGapLint reports, in a change with UI, a scenario whose THEN names a [data-testid] element but that has neither a
// ```visual block nor a `Not visual: <reason>` line (warning, a block silently dropped, e.g. during design), and a
// `Not visual` scenario about layout (error): only the visual check sees a narrow screen, long text or many rows.
func VisualGapLint(changeDir string, ui bool) []Finding {
	var out []Finding
	if !ui {
		return out
	}
	for _, s := range SpecScenarios(filepath.Join(changeDir, "specs")) {
		f := filepath.Join("specs", filepath.Base(s.File))
		if s.Shows && !s.Visual && s.NotVisual == "" {
			out = append(out, Finding{File: f, Line: s.Line, Severity: "warning", Kind: "visual-gap", Text: fmt.Sprintf("%s:%d: scenario %s checks a page element but has no ```visual block. %s", filepath.Base(s.File), s.Line, s.ID, dataStateHint)})
		}
		if x := layoutCase(s.Text); s.NotVisual != "" && !s.Visual && x != "" {
			out = append(out, Finding{File: f, Line: s.Line, Severity: "error", Kind: "not-visual-layout", Text: fmt.Sprintf("%s:%d: scenario %s is about layout (%q) but says `Not visual`: a unit test cannot see a long name or many rows push the page wider than 375px. Give it a ```visual block with a `state:` that shows it (`do:` steps, seed data or a test role the design names), checked at 375", filepath.Base(s.File), s.Line, s.ID, x)})
		}
	}
	return out
}

// ---------- edge cases ----------

var (
	edgeWords    = w(`long(?:est|er)?|empty|blank|errors?|invalid|many|lots|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|zero|maximum|minimum|max|min|limits?|boundar(?:y|ies)|duplicates?|missing|offline|slow|unicode|emoji|negative`)
	narrowEdge   = regexp.MustCompile(`(?i)\b(?:narrow|phones?|mobile|small screens?|375(?:px)?)\b`)
	contentEdge  = w(`long(?:est|er)?|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|many|lots|empty|errors?`)
	uiEdge       = w(`long(?:est|er)?|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|many|lots|narrow|phones?|mobile|375(?:px)?|empty|errors?`)
	arrowID      = regexp.MustCompile("(?i)(?:->|→|=>)\\s*((?:`?[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*`?(?:\\s*[,;]\\s*|\\s+and\\s+|\\s*))+)\\s*$")
	edgeStop     = map[string]bool{}
	edgeSkipHead = regexp.MustCompile(`(?i)^(?:context|background|current state|non-?goals?|out of scope|deferred(?: work)?|later|future(?: work)?|not in (?:this change|scope)|glossary|migration(?: plan)?|risks?(?:\s*[/&]\s*trade-?offs)?|trade-?offs|open questions|alternatives(?: considered)?)\b`)
	edgeSkipLbl  = regexp.MustCompile(`(?im)(^|[\s*_(-])(?:\*\*|__)?(?:non-?goals?|out of scope|deferred|later|future(?: work)?|not in (?:this change|scope))(?:\*\*|__)?\s*:.*$`)
	headingRE    = regexp.MustCompile(`^#{1,6}\s+(.*?)\s*$`)
	codeConstRE  = regexp.MustCompile("`([A-Z][A-Z0-9_]{2,})`")
	cssValueRE   = regexp.MustCompile(`(?i)\b(?:max|min)(?:imum)?(?:[- ](?:width|height|size))?\s*[:=]?\s*-?\d+(?:\.\d+)?\s*(?:px|rem|em|%|vw|vh|ch|pt)\b`)
	cssFuncRE    = regexp.MustCompile(`(?i)\b(?:max|min|minmax|clamp)\s*\(`)
	edgeSection  = regexp.MustCompile(`(?i)^##\s+Edge cases\b`)
	uxSection    = regexp.MustCompile(`(?i)^##\s+UX checklist\b`)
	bulletRE     = regexp.MustCompile(`^\s*[-*]\s+(.*\S)\s*$`)
	noneRE       = regexp.MustCompile(`(?i)^none\b`)
	idSplitRE    = regexp.MustCompile(`\s*[,;]\s*|\s+and\s+|\s+`)
	h2StartRE    = regexp.MustCompile(`^##\s`)
	scenLineRE   = regexp.MustCompile(`^####\s+Scenario:\s*(.*)$`)
	gwtLineRE    = regexp.MustCompile(`^\s*[-*]\s+\*\*(?:WHEN|THEN|AND|GIVEN|BUT)\*\*\s*(.*)$`)
	stateLineRE  = regexp.MustCompile(`^state:\s*(\S+)`)
	digits12RE   = regexp.MustCompile(`^\d{1,2}$`)
	stemRules    = []struct {
		re   *regexp.Regexp
		stem string
	}{
		{regexp.MustCompile(`^long(?:est|er)?$`), "long"}, {regexp.MustCompile(`^overflow`), "overflow"}, {regexp.MustCompile(`^wrap`), "wrap"},
		{regexp.MustCompile(`^truncat`), "truncat"}, {regexp.MustCompile(`^boundar`), "boundary"}, {regexp.MustCompile(`^max(?:imum)?$`), "max"},
		{regexp.MustCompile(`^min(?:imum)?$`), "min"}, {regexp.MustCompile(`^error`), "error"}, {regexp.MustCompile(`^limit`), "limit"},
		{regexp.MustCompile(`^duplicate`), "duplicate"},
	}
)

func init() {
	for s := range strings.FieldsSeq("with that this when than from into shows show state data testid fill click wait type press item items text the and for not any all new add set get via per out use its are was has can may but off too see one two yes own who how why you our") {
		edgeStop[s] = true
	}
}

// EdgeTokens are the content words of an edge case or a state, singular, 3+ letters, numbers 0/1 as zero/single.
func EdgeTokens(t string) map[string]bool {
	out := map[string]bool{}
	for _, x := range nonAlnum.Split(strings.ToLower(t), -1) {
		switch x {
		case "0", "no", "none":
			x = "zero"
		case "1", "one":
			x = "single"
		}
		if strings.HasSuffix(x, "ies") {
			x = x[:len(x)-3] + "y"
		}
		x = trimPlural(x)
		if (len(x) >= 3 || x == "no") && !edgeStop[x] && !digits12RE.MatchString(x) {
			out[x] = true
		}
	}
	return out
}

func edgeStem(x string) string {
	x = strings.ToLower(x)
	for _, r := range stemRules {
		if r.re.MatchString(x) {
			return r.stem
		}
	}
	return trimPlural(x)
}

func stemsOf(t string) map[string]bool {
	out := map[string]bool{}
	for _, x := range splitWords(t) {
		out[edgeStem(x)] = true
	}
	return out
}

// splitSentences is `split(/(?<=[.;!?])\s+/)`.
func splitSentences(l string) []string {
	var out []string
	start := 0
	for i := 0; i < len(l); i++ {
		if strings.IndexByte(".;!?", l[i]) < 0 || i+1 >= len(l) || !isSpace(l[i+1]) {
			continue
		}
		j := i + 1
		for j < len(l) && isSpace(l[j]) {
			j++
		}
		out = append(out, l[start:i+1])
		start = j
		i = j - 1
	}
	return append(out, l[start:])
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

// edgeProse is the prose of a plan document where an edge word means a case the change must handle.
func edgeProse(t string, codes map[string]bool) string {
	var out []string
	skip := false
	for raw := range strings.SplitSeq(strings.ReplaceAll(StripComments(t), "\r\n", "\n"), "\n") {
		if h := headingRE.FindStringSubmatch(raw); h != nil {
			skip = edgeSkipHead.MatchString(strings.NewReplacer("*", "", "_", "", "`", "").Replace(h[1]))
			continue
		}
		if skip {
			continue
		}
		line := edgeSkipLbl.ReplaceAllString(raw, "$1")
		for _, sent := range splitSentences(line) {
			hit := false
			for _, m := range codeConstRE.FindAllStringSubmatch(sent, -1) {
				if codes[m[1]] {
					hit = true
				}
			}
			if hit {
				continue
			}
			out = append(out, prose(cssFuncRE.ReplaceAllString(cssValueRE.ReplaceAllString(sent, " "), " (")))
		}
	}
	return strings.Join(out, "\n")
}

func scenarioWords(specsDir string) (map[string]bool, map[string]bool) {
	var txt strings.Builder
	codes := map[string]bool{}
	for _, sf := range SpecFiles(specsDir) {
		for _, l := range lines(sf.File) {
			m := scenLineRE.FindStringSubmatch(l)
			if m == nil {
				m = gwtLineRE.FindStringSubmatch(l)
			}
			if m == nil {
				m = stateLineRE.FindStringSubmatch(l)
			}
			if m == nil {
				continue
			}
			txt.WriteString(" " + strings.ReplaceAll(m[1], "-", " "))
			for _, c := range codeConstRE.FindAllStringSubmatch(m[1], -1) {
				codes[c[1]] = true
			}
		}
	}
	return stemsOf(txt.String()), codes
}

// VisualState is one state of a visual scenario, as far as the edge-case rule needs it.
type VisualState struct {
	Name  string `json:"name"`
	Steps []any  `json:"steps"`
	Keys  []any  `json:"keys"`
}

// VisualScenario is a visual scenario of the change by id. Viewports are its widths: a case that is only about a
// narrow screen is shown by a narrow viewport and needs no state; long text or an empty list at 375 still does.
type VisualScenario struct {
	States    []VisualState
	Viewports []int
}

// EdgeItem is one bullet of proposal.md ## Edge cases.
type EdgeItem struct {
	Line int      `json:"line"`
	Text string   `json:"text"`
	IDs  []string `json:"ids"`
	UI   bool     `json:"ui"`
}

func splitIDs(s string) []string {
	var out []string
	for _, x := range idSplitRE.Split(s, -1) {
		if x = strings.TrimSpace(strings.ReplaceAll(x, "`", "")); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
