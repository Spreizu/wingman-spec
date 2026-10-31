package quality

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
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
				cur = &Scenario{ID: sf.Cap + "/" + spec.Slug(m[1]), Capability: sf.Cap, Requirement: req, Name: m[1], File: sf.File, Line: i + 1}
				out = append(out, cur)
			} else if cur != nil {
				if m := notVisualRE.FindStringSubmatch(l); m != nil {
					cur.NotVisual = m[1]
				}
				cur.Shows = cur.Shows || thenTestID.MatchString(l)
			}
		}
	}
	return out
}

const dataStateHint = "Never delete a scenario or its ```visual block: when the live app lacks the data, reach the state with a test role in `visual.roles`, seed data in `visual.command` or a route, and say which in design.md; only when none works, write `Not visual: <reason>; covered by <test>` under the scenario"

// VisualGapLint warns, in a change with UI, about a scenario whose THEN names a [data-testid] element but that has
// neither a ```visual block nor a `Not visual: <reason>` line (a visual block silently dropped, e.g. during design).
func VisualGapLint(changeDir string, ui bool) []Finding {
	var out []Finding
	if !ui {
		return out
	}
	for _, s := range SpecScenarios(filepath.Join(changeDir, "specs")) {
		if s.Shows && !s.Visual && s.NotVisual == "" {
			out = append(out, Finding{File: filepath.Join("specs", filepath.Base(s.File)), Line: s.Line, Severity: "warning", Kind: "visual-gap", Text: fmt.Sprintf("%s:%d: scenario %s checks a page element but has no ```visual block. %s", filepath.Base(s.File), s.Line, s.ID, dataStateHint)})
		}
	}
	return out
}

// ---------- edge cases ----------

var (
	edgeWords    = w(`long(?:est|er)?|empty|blank|errors?|invalid|many|lots|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|zero|maximum|minimum|max|min|limits?|boundar(?:y|ies)|duplicates?|missing|offline|slow|unicode|emoji|negative`)
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

// VisualScenario is a visual scenario of the change by id.
type VisualScenario struct{ States []VisualState }

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

// EdgeLint checks proposal.md `## Edge cases`: one bullet per edge case ending with `-> <capability>/<scenario-slug>`.
// livingDir is used for a slice change, whose edge cases are scenarios of the living specs.
// ui marks a change with UI files in tasks.md, so a UI case needs a visual state even when no block is left.
func EdgeLint(changeDir, livingDir string, visual map[string]VisualScenario, ui bool) ([]EdgeItem, []Finding) {
	var out []Finding
	items := []EdgeItem{}
	prop, ok := readIf(filepath.Join(changeDir, "proposal.md"))
	if !ok {
		return items, out
	}
	text := strings.ReplaceAll(StripComments(prop), "\r\n", "\n")
	ls := strings.Split(text, "\n")
	start := slices.IndexFunc(ls, edgeSection.MatchString)
	isSlice := sliceRE.MatchString(text)
	dir := filepath.Join(changeDir, "specs")
	if isSlice {
		dir = livingDir
	}
	scen := map[string]*Scenario{}
	for _, s := range SpecScenarios(dir) {
		scen[s.ID] = s
	}
	if start < 0 {
		if isSlice {
			return items, out
		}
		return items, append(out, Finding{File: "proposal.md", Line: 1, Severity: "error", Kind: "edge-cases", Text: `proposal.md has no "## Edge cases" section: list every edge case or boundary the request or the user's answers name (long text, empty, error, many items, limits, invalid input), one bullet each ending with "-> <capability>/<scenario-slug>" (the scenario that proves it), or "- none named"`})
	}
	none := false
	end := start + 1
	for ; end < len(ls) && !h2StartRE.MatchString(ls[end]); end++ {
		i := end
		b := bulletRE.FindStringSubmatch(ls[i])
		if b == nil {
			continue
		}
		if noneRE.MatchString(strings.NewReplacer("`", "", "*", "", "_", "").Replace(b[1])) {
			none = true
			continue
		}
		var ids []string
		desc := b[1]
		if m := arrowID.FindStringSubmatchIndex(b[1]); m != nil {
			ids = splitIDs(b[1][m[2]:m[3]])
			desc = strings.TrimSpace(b[1][:m[0]])
		}
		item := EdgeItem{Line: i + 1, Text: desc, IDs: ids, UI: uiEdge.match(desc)}
		items = append(items, item)
		if len(ids) == 0 {
			out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf(`proposal.md:%d: edge case "%s" names no scenario: end the bullet with "-> <capability>/<scenario-slug>" and give that case its own scenario in the specs (Size never removes one)`, i+1, cut(desc, 80))})
			continue
		}
		var unknown []string
		for _, id := range ids {
			if scen[id] == nil {
				unknown = append(unknown, id)
			}
		}
		if len(unknown) > 0 {
			out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf(`proposal.md:%d: edge case "%s" points at %s, which is not a scenario of this change (scenario ids are <capability>/<slug of the scenario name>)`, i+1, cut(desc, 80), strings.Join(unknown, ", "))})
		}
		if item.UI && (len(visual) > 0 || ui) && len(unknown) == 0 {
			want := EdgeTokens(desc)
			found := false
			for _, id := range ids {
				found = found || scen[id].NotVisual != ""
				v, ok := visual[id]
				if !ok {
					continue
				}
				for _, st := range v.States {
					if st.Name == "default" || (len(st.Steps) == 0 && len(st.Keys) == 0) {
						continue
					}
					steps, _ := json.Marshal(st.Steps)
					for t := range EdgeTokens(st.Name + " " + string(steps)) {
						if want[t] {
							found = true
						}
					}
				}
			}
			if !found {
				out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf("proposal.md:%d: UI edge case \"%s\" needs a visual scenario with a state that shows it (e.g. `state: long-name` with `do:` steps that add an item with the long text, checked at 375; the state name or its steps should name the case): none of %s has one. %s", i+1, cut(desc, 80), strings.Join(ids, ", "), dataStateHint)})
			}
		}
	}
	stems, codes := scenarioWords(filepath.Join(changeDir, "specs"))
	var itemTexts []string
	for _, it := range items {
		itemTexts = append(itemTexts, it.Text)
	}
	covered := stemsOf(strings.Join(itemTexts, " "))
	for k := range stems {
		covered[k] = true
	}
	rest := slices.Concat(ls[:start], ls[end:])
	var kept []string
	skip := false
	for _, l := range rest {
		if h2StartRE.MatchString(l) {
			skip = uxSection.MatchString(l)
		}
		if !skip {
			kept = append(kept, l)
		}
	}
	design, _ := readIf(filepath.Join(changeDir, "design.md"))
	dmap, _ := readIf(filepath.Join(changeDir, "design-map.md"))
	var missed []string
	for _, t := range []string{strings.Join(kept, "\n"), design, dmap} {
		for _, x := range edgeWords.all(edgeProse(t, codes)) {
			x = strings.ToLower(x)
			if !covered[edgeStem(x)] && !slices.Contains(missed, x) {
				missed = append(missed, x)
			}
		}
	}
	if len(missed) > 0 && (none || len(items) > 0) {
		var q []string
		for _, x := range missed[:min(6, len(missed))] {
			q = append(q, `"`+x+`"`)
		}
		out = append(out, Finding{File: "proposal.md", Line: start + 1, Severity: "warning", Kind: "edge-cases", Text: fmt.Sprintf("proposal.md:%d: the plan mentions %s but neither the Edge cases list nor a scenario does; if the request or the user's answers name such a case, list it with its scenario", start+1, strings.Join(q, ", "))})
	}
	return items, out
}

// ---------- UX checklist ----------

// UXItems are the UX checklist items of a UI-facing change.
var UXItems = []string{"loading", "empty", "error", "disabled", "validation", "recovery", "keyboard", "narrow", "long-text"}

var (
	filesLineRE = regexp.MustCompile(`(?i)^\s*[-*]\s+Files:\s*(.*)$`)
	fileTokRE   = regexp.MustCompile(`[\w@./$()\[\]-]+\.\w+`)
	uxLineRE    = regexp.MustCompile("(?i)^\\s*[-*]\\s+`?([a-z][a-z -]*?)`?\\s*:\\s*(.*\\S)\\s*$")
	uxSepRE     = regexp.MustCompile(`[ _]+`)
	naRE        = regexp.MustCompile("(?i)^`?not applicable`?\\s*[:\\-–]\\s*(.*)$")
	scRE        = regexp.MustCompile(`(?i)^scenarios?\s+(.*)$`)
	hasWordRE   = regexp.MustCompile(`\w`)
)

// TaskUIFiles are the UI files named by the Files: lines of tasks.md (test files do not count).
func TaskUIFiles(changeDir string, exts ...string) []string {
	t, ok := readIf(filepath.Join(changeDir, "tasks.md"))
	if !ok {
		return nil
	}
	var out []string
	for l := range strings.SplitSeq(strings.ReplaceAll(StripComments(t), "\r\n", "\n"), "\n") {
		m := filesLineRE.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		for _, f := range fileTokRE.FindAllString(m[1], -1) {
			if testpaths.IsUIFile(f, exts...) && !testpaths.IsTestPath(f) && !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

func firstN(xs []string, n int) string {
	s := strings.Join(xs[:min(n, len(xs))], ", ")
	if len(xs) > n {
		s += ", ..."
	}
	return s
}

// UXLint checks the UX checklist of a UI-facing change (warnings only). visualIDs are the change's visual scenarios.
func UXLint(changeDir string, visualIDs []string, uiExts ...string) []Finding {
	var out []Finding
	prop, ok := readIf(filepath.Join(changeDir, "proposal.md"))
	if !ok {
		return out
	}
	text := strings.ReplaceAll(StripComments(prop), "\r\n", "\n")
	if sliceRE.MatchString(text) {
		return out
	}
	ui := TaskUIFiles(changeDir, uiExts...)
	if len(visualIDs) == 0 && len(ui) == 0 {
		return out
	}
	why := "UI files " + firstN(ui, 2)
	if len(visualIDs) > 0 {
		why = "visual scenarios " + firstN(visualIDs, 2)
	}
	form := "one line per item: `- <item>: scenario <capability>/<slug>` or `- <item>: Not applicable: <reason>`"
	ls := strings.Split(text, "\n")
	start := slices.IndexFunc(ls, uxSection.MatchString)
	if start < 0 {
		return append(out, Finding{File: "proposal.md", Line: 1, Severity: "warning", Kind: "ux-checklist", Text: fmt.Sprintf(`proposal.md: this change is UI-facing (%s) but has no "## UX checklist" section: answer %s, %s`, why, strings.Join(UXItems, ", "), form)})
	}
	scen := map[string]bool{}
	for _, s := range SpecScenarios(filepath.Join(changeDir, "specs")) {
		scen[s.ID] = true
	}
	seen := map[string]bool{}
	for i := start + 1; i < len(ls) && !h2StartRE.MatchString(ls[i]); i++ {
		m := uxLineRE.FindStringSubmatch(ls[i])
		if m == nil {
			continue
		}
		item := uxSepRE.ReplaceAllString(strings.ToLower(m[1]), "-")
		if !slices.Contains(UXItems, item) {
			continue
		}
		seen[item] = true
		ans := strings.NewReplacer("*", "", "_", "").Replace(m[2])
		if na := naRE.FindStringSubmatch(ans); na != nil {
			n := 0
			for x := range strings.FieldsSeq(na[1]) {
				if hasWordRE.MatchString(x) {
					n++
				}
			}
			if n < 3 {
				out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "warning", Kind: "ux-checklist", Text: fmt.Sprintf(`proposal.md:%d: UX checklist "%s": "Not applicable" needs the reason this screen has none (3+ words, e.g. "static list, no network call")`, i+1, item)})
			}
		} else if sc := scRE.FindStringSubmatch(ans); sc != nil {
			ids := splitIDs(sc[1])
			var bad []string
			for _, id := range ids {
				if !scen[id] {
					bad = append(bad, id)
				}
			}
			if len(ids) == 0 || len(bad) > 0 {
				what := "no scenario"
				if len(bad) > 0 {
					what = strings.Join(bad, ", ")
				}
				out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "warning", Kind: "ux-checklist", Text: fmt.Sprintf(`proposal.md:%d: UX checklist "%s" names %s, which is not a scenario of this change (ids are <capability>/<slug of the scenario name>)`, i+1, item, what)})
			}
		} else {
			out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "warning", Kind: "ux-checklist", Text: fmt.Sprintf("proposal.md:%d: UX checklist \"%s\": write `scenario <capability>/<slug>` or `Not applicable: <reason>`", i+1, item)})
		}
	}
	var miss []string
	for _, x := range UXItems {
		if !seen[x] {
			miss = append(miss, x)
		}
	}
	if len(miss) > 0 {
		out = append(out, Finding{File: "proposal.md", Line: start + 1, Severity: "warning", Kind: "ux-checklist", Text: fmt.Sprintf("proposal.md:%d: UX checklist has no answer for %s: %s", start+1, strings.Join(miss, ", "), form)})
	}
	return out
}

// ---------- Purpose of new capabilities, vague THEN lines ----------

var purposeHeadRE = regexp.MustCompile(`^##\s+Purpose\s*$`)

// PurposeLint checks that a new capability (no living spec yet) has a `## Purpose` of 50+ characters.
func PurposeLint(changeDir, livingDir string) []Finding {
	var out []Finding
	for _, sf := range SpecFiles(filepath.Join(changeDir, "specs")) {
		if _, err := os.Stat(filepath.Join(livingDir, sf.Cap+".md")); err == nil {
			continue
		}
		b, _ := os.ReadFile(sf.File)
		ls := strings.Split(strings.ReplaceAll(StripComments(string(b)), "\r\n", "\n"), "\n")
		at := slices.IndexFunc(ls, purposeHeadRE.MatchString)
		if at < 0 {
			out = append(out, Finding{File: sf.File, Line: 1, Severity: "warning", Kind: "purpose", Text: fmt.Sprintf(`specs/%s.md: new capability without "## Purpose": sync then writes a "TBD" placeholder into the living spec; add one or two sentences (50+ characters) saying what the capability is for`, sf.Cap)})
			continue
		}
		var body []string
		for _, l := range ls[at+1:] {
			if h2StartRE.MatchString(l) {
				break
			}
			body = append(body, l)
		}
		text := strings.Join(strings.Fields(strings.Join(body, " ")), " ")
		if n := len([]rune(text)); n < 50 {
			out = append(out, Finding{File: sf.File, Line: at + 1, Severity: "error", Kind: "purpose", Text: fmt.Sprintf(`specs/%s.md:%d: "## Purpose" has %d characters; a new capability needs 50+ (validate fails on the living spec otherwise): write one or two full sentences`, sf.Cap, at+1, n)})
		}
	}
	return out
}

var (
	vagueThen    = regexp.MustCompile(`(?i)\b(gracefully|properly|correctly|appropriately|appropriate|as expected|successfully|works|handled|handles)\b`)
	thenLineRE   = regexp.MustCompile(`^\s*[-*]\s+\*\*(THEN|AND)\*\*\s+(.*)$`)
	concreteThen = regexp.MustCompile("\"[^\"]+\"|“[^”]+”|`[^`]+`|\\d")
)

// ThenLint lists THEN/AND lines that promise a result without naming it (info only).
func ThenLint(changeDir string) []Finding {
	var out []Finding
	for _, sf := range SpecFiles(filepath.Join(changeDir, "specs")) {
		b, _ := os.ReadFile(sf.File)
		for i, l := range strings.Split(strings.ReplaceAll(StripComments(string(b)), "\r\n", "\n"), "\n") {
			m := thenLineRE.FindStringSubmatch(l)
			if m == nil || concreteThen.MatchString(m[2]) {
				continue
			}
			x := vagueThen.FindString(m[2])
			if x == "" {
				continue
			}
			out = append(out, Finding{File: sf.File, Line: i + 1, Severity: "info", Kind: "vague-then", Text: fmt.Sprintf(`specs/%s.md:%d: %s "%s" says "%s" but names no value a test can check. Name the result: a quoted text, a number or a state, e.g. THEN the row shows "Overdue".`, sf.Cap, i+1, m[1], cut(m[2], 60), x)})
		}
	}
	return out
}

// ---------- accessible names ----------

var (
	namedOpenRE  = regexp.MustCompile(`<(button|a|summary|label|h[1-6]|[A-Z][A-Za-z]*(?:Button|Link))\b([^>]*?)\s(?::|v-bind:)?aria-label\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})([^>]*)>`)
	hiddenOpenRE = regexp.MustCompile(`(?i)<(\w[\w-]*)\b[^>]*(?:aria-hidden\s*=\s*["']?true|class\s*=\s*["'][^"']*\b(?:sr-only|visually-hidden|screen-reader-text)\b)[^>]*>`)
	htmlCommRE   = regexp.MustCompile(`(?s)<!--.*?-->`)
	tagRE        = regexp.MustCompile(`<[^>]+>`)
	emptyMustRE  = regexp.MustCompile(`\{\{\s*(?:''|"")\s*\}\}`)
	nbspRE       = regexp.MustCompile(`&nbsp;|&#160;`)
	selfCloseRE  = regexp.MustCompile(`/\s*$`)
)

// AriaFinding is a control with an aria-label and visible text.
type AriaFinding struct {
	Line    int    `json:"line"`
	Tag     string `json:"tag"`
	Label   string `json:"label"`
	Visible string `json:"visible"`
	Text    string `json:"text"`
}

// closeAfter finds `</tag\s*>` after pos (case-sensitive like the original backreference).
func closeAfter(src, tag string, pos int, fold bool) (int, int) {
	for i := pos; i < len(src); {
		j := strings.Index(src[i:], "</")
		if j < 0 {
			return -1, -1
		}
		a := i + j
		b := a + 2
		name := src[b:min(b+len(tag), len(src))]
		if name == tag || (fold && strings.EqualFold(name, tag)) {
			k := b + len(tag)
			for k < len(src) && isSpace(src[k]) {
				k++
			}
			if k < len(src) && src[k] == '>' {
				return a, k + 1
			}
		}
		i = a + 2
	}
	return -1, -1
}

func dropHidden(inner string) string {
	for range 3 {
		var b strings.Builder
		pos := 0
		for pos < len(inner) {
			loc := hiddenOpenRE.FindStringSubmatchIndex(inner[pos:])
			if loc == nil {
				break
			}
			tag := inner[pos+loc[2] : pos+loc[3]]
			a, e := closeAfter(inner, tag, pos+loc[1], true)
			if a < 0 {
				b.WriteString(inner[pos : pos+loc[1]])
				pos += loc[1]
				continue
			}
			b.WriteString(inner[pos : pos+loc[0]])
			b.WriteString(" ")
			pos = e
		}
		b.WriteString(inner[pos:])
		inner = b.String()
	}
	return inner
}

// AriaLabelFindings lists controls with an aria-label AND visible text in a markup file (WCAG 2.5.3).
func AriaLabelFindings(abs, rel string) []AriaFinding {
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil
	}
	src := string(b)
	var out []AriaFinding
	for pos := 0; pos < len(src); {
		loc := namedOpenRE.FindStringSubmatchIndex(src[pos:])
		if loc == nil {
			break
		}
		g := func(i int) string { return src[pos+loc[2*i] : pos+loc[2*i+1]] }
		start, openEnd := pos+loc[0], pos+loc[1]
		tag, label, rest := g(1), g(3), g(4)
		a, e := closeAfter(src, tag, openEnd, false)
		if a < 0 {
			pos = start + 1
			continue
		}
		pos = e
		if selfCloseRE.MatchString(rest) {
			continue
		}
		inner := dropHidden(src[openEnd:a])
		visible := htmlCommRE.ReplaceAllString(inner, " ")
		visible = tagRE.ReplaceAllString(visible, " ")
		visible = emptyMustRE.ReplaceAllString(visible, " ")
		visible = nbspRE.ReplaceAllString(visible, " ")
		visible = strings.Join(strings.Fields(visible), " ")
		if !strings.Contains(visible, "{{") && !strings.ContainsFunc(visible, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) {
			continue
		}
		line := strings.Count(src[:start], "\n") + 1
		v := cut(visible, 60)
		out = append(out, AriaFinding{Line: line, Tag: tag, Label: label, Visible: v, Text: fmt.Sprintf(`%s:%d: <%s> has aria-label=%s and visible text "%s": the aria-label replaces the visible text as its accessible name, which must contain that text (axe label-content-name-mismatch). Drop the aria-label and extend the visible text with visually hidden text that starts with an explicit space ({{ ' ' }} or &nbsp;, e.g. Cart<span class="sr-only">{{ ' ' }}{{ n }} items</span>), mark a decorative badge aria-hidden="true", or use aria-describedby`, rel, line, tag, cut(label, 60), v)})
	}
	return out
}
