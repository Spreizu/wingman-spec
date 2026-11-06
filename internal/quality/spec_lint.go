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

	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// EdgeLint checks proposal.md `## Edge cases`: one bullet per edge case ending with `-> <capability>/<scenario-slug>`.
// livingDir is used for a slice change, whose edge cases are scenarios of the living specs.
// ui marks a change with UI files in tasks.md, so a UI case needs a visual state even when no block is left.
func EdgeLint(changeDir, livingDir string, visual map[string]VisualScenario, ui bool) ([]EdgeItem, []Finding) {
	var out []Finding
	items := []EdgeItem{}
	prop, ok := layout.ReadString(filepath.Join(changeDir, "proposal.md"))
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
			out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf(`proposal.md:%d: edge case "%s" names no scenario: end the bullet with "-> <capability>/<scenario-slug>" and give that case its own scenario in the specs (Size never removes one)`, i+1, layout.Cut(desc, 80))})
			continue
		}
		var unknown []string
		for _, id := range ids {
			if scen[id] == nil {
				unknown = append(unknown, id)
			}
		}
		if len(unknown) > 0 {
			out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf(`proposal.md:%d: edge case "%s" points at %s, which is not a scenario of this change (scenario ids are <capability>/<slug of the scenario name>)`, i+1, layout.Cut(desc, 80), strings.Join(unknown, ", "))})
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
				found = found || (narrowEdge.MatchString(desc) && !contentEdge.match(desc) && slices.ContainsFunc(v.Viewports, func(w int) bool { return w <= 480 }))
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
				out = append(out, Finding{File: "proposal.md", Line: i + 1, Severity: "error", Kind: "edge-cases", Text: fmt.Sprintf("proposal.md:%d: UI edge case \"%s\" needs a visual scenario with a state that shows it (e.g. `state: long-name` with `do:` steps that add an item with the long text, checked at 375; the state name or its steps should name the case; a narrow case needs only `viewports: 375`): none of %s has one. %s", i+1, layout.Cut(desc, 80), strings.Join(ids, ", "), dataStateHint)})
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
	design, _ := layout.ReadString(filepath.Join(changeDir, "design.md"))
	dmap, _ := layout.ReadString(filepath.Join(changeDir, "design-map.md"))
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
	t, ok := layout.ReadString(filepath.Join(changeDir, "tasks.md"))
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
	prop, ok := layout.ReadString(filepath.Join(changeDir, "proposal.md"))
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
		b, err := os.ReadFile(sf.File)
		if err != nil {
			continue
		}
		for i, l := range strings.Split(strings.ReplaceAll(StripComments(string(b)), "\r\n", "\n"), "\n") {
			m := thenLineRE.FindStringSubmatch(l)
			if m == nil || concreteThen.MatchString(m[2]) {
				continue
			}
			x := vagueThen.FindString(m[2])
			if x == "" {
				continue
			}
			out = append(out, Finding{File: sf.File, Line: i + 1, Severity: "info", Kind: "vague-then", Text: fmt.Sprintf(`specs/%s.md:%d: %s "%s" says "%s" but names no value a test can check. Name the result: a quoted text, a number or a state, e.g. THEN the row shows "Overdue".`, sf.Cap, i+1, m[1], layout.Cut(m[2], 60), x), Fix: `Name a quoted text, a number or a state the test can check.`})
		}
	}
	return out
}

// ---------- accessible names ----------

var (
	namedOpenRE  = regexp.MustCompile(`<(button|a|summary|label|h[1-6]|[A-Z][A-Za-z]*(?:Button|Link))\b([^>]*?)\s(?::|v-bind:)?aria-label\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})([^>]*)>`)
	hiddenOpenRE = regexp.MustCompile(`(?i)<(\w[\w-]*)\b[^>]*(?:aria-hidden\s*=\s*["']?true|class\s*=\s*["'][^"']*\b(?:sr-only|visually-hidden|screen-reader-text)\b)[^>]*>`)
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
		visible := layout.StripComments(strings.ReplaceAll(inner, "<!--", " <!--"), false)
		visible = tagRE.ReplaceAllString(visible, " ")
		visible = emptyMustRE.ReplaceAllString(visible, " ")
		visible = nbspRE.ReplaceAllString(visible, " ")
		visible = strings.Join(strings.Fields(visible), " ")
		if !strings.Contains(visible, "{{") && !strings.ContainsFunc(visible, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) {
			continue
		}
		line := strings.Count(src[:start], "\n") + 1
		v := layout.Cut(visible, 60)
		out = append(out, AriaFinding{Line: line, Tag: tag, Label: label, Visible: v, Text: fmt.Sprintf(`%s:%d: <%s> has aria-label=%s and visible text "%s": the aria-label replaces the visible text as its accessible name, which must contain that text (axe label-content-name-mismatch). Drop the aria-label and extend the visible text with visually hidden text that starts with an explicit space ({{ ' ' }} or &nbsp;, e.g. Cart<span class="sr-only">{{ ' ' }}{{ n }} items</span>), mark a decorative badge aria-hidden="true", or use aria-describedby`, rel, line, tag, layout.Cut(label, 60), v)})
	}
	return out
}

var testingSection = regexp.MustCompile(`(?i)^testing approach\b`)

// ReachLint checks the full path (design.md exists): a change whose visual scenarios have states needs a **Testing
// approach** section in design.md (error), and that section names each such scenario (its id or slug) with how its
// states are reached (warning).
func ReachLint(changeDir string, vm map[string]VisualScenario) []Finding {
	design, ok := layout.ReadString(filepath.Join(changeDir, "design.md"))
	if !ok {
		return nil
	}
	var need []string
	for id, s := range vm {
		if slices.ContainsFunc(s.States, func(st VisualState) bool { return !strings.EqualFold(st.Name, "default") }) {
			need = append(need, id)
		}
	}
	if len(need) == 0 {
		return nil
	}
	slices.Sort(need)
	sec := strings.ToLower(Section(StripComments(design), testingSection))
	if strings.TrimSpace(sec) == "" {
		return []Finding{{File: "design.md", Line: 1, Severity: "error", Kind: "visual-reach", Text: fmt.Sprintf("no ## Testing approach: say how each visual state is reached (role, seed data or route) for %s", strings.Join(need, ", "))}}
	}
	line := 1
	for i, l := range strings.Split(design, "\n") {
		if h2RE.MatchString(l) && testingSection.MatchString(strings.TrimSpace(strings.TrimPrefix(l, "##"))) {
			line = i + 1
		}
	}
	var out []Finding
	for _, id := range need {
		_, slug, _ := strings.Cut(id, "/")
		if !strings.Contains(sec, strings.ToLower(id)) && !strings.Contains(sec, slug) && !strings.Contains(sec, strings.ReplaceAll(slug, "-", " ")) {
			out = append(out, Finding{File: "design.md", Line: line, Severity: "warning", Kind: "visual-reach", Text: fmt.Sprintf("## Testing approach does not name visual scenario %s: say how its states are reached (role, seed data, route, or that the live app shows them)", id)})
		}
	}
	return out
}
