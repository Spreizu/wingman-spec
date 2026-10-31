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

// Upgrade is recorded by `check` when an edit moved a change off the fast path.
type Upgrade struct {
	At      string   `json:"at,omitempty"`
	Reasons []string `json:"reasons"`
}

// Facts are what a change's proposal, specs, ADRs and tasks contain.
type Facts struct {
	Files          []string `json:"files"`
	HasDesign      bool     `json:"has_design"`
	HasAppMap      bool     `json:"has_app_map"`
	HasADRFile     bool     `json:"has_adr_file"`
	SpecOnly       bool     `json:"spec_only"`
	Upgrade        *Upgrade `json:"upgrade"`
	Declared       string   `json:"declared"`
	DeclaredLine   int      `json:"declared_line"`
	Risk           []string `json:"risk"`
	TasksSize      string   `json:"tasks_size"`
	Capabilities   []string `json:"capabilities"`
	Requirements   int      `json:"requirements"`
	VisualBlocks   int      `json:"visual_blocks"`
	Breaking       bool     `json:"breaking"`
	ADRs           []string `json:"adrs"`
	RiskyGroups    []string `json:"risky_groups"`
	RiskWords      []string `json:"risk_words"`
	DesignSections []string `json:"design_sections"`
	AppMapSections []string `json:"app_map_sections"`
	HasProposal    bool     `json:"has_proposal"`
	IsSlice        bool     `json:"is_slice"`
}

var (
	riskWordsRE  = regexp.MustCompile(`(?i)\b(payments?|refunds?|invoices?|billing|discounts?|currenc(?:y|ies)|money|passwords?|authenticat\w*|authori[sz]\w*|encrypt\w*|secrets?|credentials?|migrat\w*|concurren\w*|race conditions?|public api)\b`)
	fenceOpenRE  = regexp.MustCompile("^\\s*(`{3,}|~{3,})\\s*(\\S*)")
	h2CapRE      = regexp.MustCompile(`^##\s+(.*?)\s*$`)
	reqLineRE    = regexp.MustCompile(`^###\s+Requirement:`)
	addModRE     = regexp.MustCompile(`(?i)^(ADDED|MODIFIED)\b`)
	removedRE    = regexp.MustCompile(`(?i)^REMOVED\b`)
	breakingRE   = regexp.MustCompile(`\*\*BREAKING\*\*|\bBREAKING\b`)
	specOnlyRE   = regexp.MustCompile(`(?mi)^\s*(?:[-*]\s+)?\**Kind\**:\s*\**spec-only\b`)
	sliceRE      = regexp.MustCompile(`(?m)^Slice:\s*\S`)
	h2AllRE      = regexp.MustCompile(`(?m)^##\s+(.*?)\s*$`)
	whatRE       = regexp.MustCompile(`(?i)^what changes`)
	whyWhatImpRE = regexp.MustCompile(`(?i)^(why|what changes|impact)`)
	whyRE        = regexp.MustCompile(`(?i)^why`)
	sensitiveRE  = regexp.MustCompile(`(?i)(^|[/_.-])(auth\w*|session\w*|passw\w*|permission\w*|rbac|acl|payment\w*|billing|money|migrat\w*|schema\w*|secret\w*|credential\w*|token\w*|openapi|swagger)([/_.-]|$)|(^|/)(\.env\S*|package(-lock)?\.json|requirements\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle\S*|yarn\.lock|pnpm-lock\.yaml)$`)
)

// IsVisualFence reports whether a fence opener names the visual language.
func isVisual(lang string) bool { return strings.EqualFold(lang, "visual") }

// SizeFacts reads what the change's artifacts contain.
func SizeFacts(changeDir string, upgrade *Upgrade) Facts {
	f := Facts{Upgrade: upgrade, Capabilities: []string{}, ADRs: []string{}, RiskyGroups: []string{}, RiskWords: []string{}, Files: []string{}}
	proposal, hasProp := readIf(filepath.Join(changeDir, "proposal.md"))
	f.HasProposal = hasProp && proposal != ""
	if hasProp {
		ps := ReadProposalSize(proposal)
		f.Declared, f.DeclaredLine, f.Risk = ps.Size, ps.Line, ps.Risk
	}
	breakingSpecs := false
	for _, sf := range SpecFiles(filepath.Join(changeDir, "specs")) {
		f.Capabilities = append(f.Capabilities, sf.Cap)
		t, _ := readIf(sf.File)
		sec := ""
		fence := false
		for l := range strings.SplitSeq(strings.ReplaceAll(t, "\r\n", "\n"), "\n") {
			if m := fenceOpenRE.FindStringSubmatch(l); m != nil {
				if !fence && isVisual(m[2]) {
					f.VisualBlocks++
				}
				fence = !fence
				continue
			}
			if fence {
				continue
			}
			if m := h2CapRE.FindStringSubmatch(l); m != nil {
				sec = m[1]
				continue
			}
			if reqLineRE.MatchString(l) && addModRE.MatchString(sec) {
				f.Requirements++
			}
			if reqLineRE.MatchString(l) && removedRE.MatchString(sec) {
				breakingSpecs = true
			}
		}
	}
	what := ""
	if hasProp {
		what = StripComments(Section(proposal, whatRE))
	}
	f.Breaking = breakingRE.MatchString(what) || breakingSpecs
	adrDir := filepath.Join(changeDir, "adrs")
	if ents, err := os.ReadDir(adrDir); err == nil {
		for _, e := range ents {
			if !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			f.HasADRFile = true
			t, _ := readIf(filepath.Join(adrDir, e.Name()))
			if !IsNoneADR(e.Name(), t) {
				f.ADRs = append(f.ADRs, e.Name())
			}
		}
	}
	if t, ok := readIf(filepath.Join(changeDir, "tasks.md")); ok {
		p := tasks.Parse(t)
		f.TasksSize = p.Size
		for _, g := range p.Groups {
			if g.Risky && !g.QA {
				f.RiskyGroups = append(f.RiskyGroups, g.Title)
			}
			for _, x := range g.Tasks {
				for _, file := range x.Files {
					if !slices.Contains(f.Files, file) {
						f.Files = append(f.Files, file)
					}
				}
			}
		}
	}
	if hasProp {
		for _, w := range riskWordsRE.FindAllString(StripComments(Section(proposal, whyWhatImpRE)), -1) {
			w = strings.ToLower(w)
			if !slices.Contains(f.RiskWords, w) {
				f.RiskWords = append(f.RiskWords, w)
			}
		}
	}
	if d, ok := readIf(filepath.Join(changeDir, "design.md")); ok {
		f.HasDesign = true
		f.DesignSections = headings(d)
	}
	if a, ok := readIf(filepath.Join(changeDir, "app-map.md")); ok {
		f.HasAppMap = true
		f.AppMapSections = headings(a)
	}
	f.SpecOnly = specOnlyRE.MatchString(proposal)
	f.IsSlice = sliceRE.MatchString(proposal)
	return f
}

func headings(t string) []string {
	out := []string{}
	for _, m := range h2AllRE.FindAllStringSubmatch(t, -1) {
		out = append(out, strings.ToLower(m[1]))
	}
	return out
}

// IsSensitivePath reports whether a path makes a small change no longer small: auth, sessions, permissions, money,
// schema and migrations, secrets, tokens, API specs and dependency manifests.
func IsSensitivePath(f string) bool { return !testpaths.IsTestPath(f) && sensitiveRE.MatchString(f) }

// Required is the size the facts require, with the reasons per size.
type Required struct {
	Size    string              `json:"size"`
	Reasons map[string][]string `json:"reasons"`
}

// RequiredSize is the size the facts require.
func RequiredSize(f Facts) Required {
	L, M := []string{}, []string{}
	if len(f.Capabilities) > MMaxCapabilities {
		L = append(L, fmt.Sprintf("%d capabilities (%s; 3+ is L)", len(f.Capabilities), strings.Join(f.Capabilities, ", ")))
	}
	if f.Breaking {
		L = append(L, "a BREAKING change (proposal What Changes, or a REMOVED requirement)")
	}
	if len(f.Risk) > 0 {
		L = append(L, fmt.Sprintf("Risk: %s (any risk is L)", strings.Join(f.Risk, ", ")))
	}
	if len(f.RiskyGroups) > 0 {
		L = append(L, "tasks.md group(s) marked (risky): "+strings.Join(f.RiskyGroups, "; "))
	}
	if len(f.Capabilities) > SMaxCapabilities {
		M = append(M, fmt.Sprintf("%d capabilities (S is 1)", len(f.Capabilities)))
	}
	if f.Requirements > SMaxRequirements {
		M = append(M, fmt.Sprintf("%d requirements (S is at most %d)", f.Requirements, SMaxRequirements))
	}
	if f.VisualBlocks > 0 {
		M = append(M, fmt.Sprintf("%d visual scenario block(s) (any UI change with visual scenarios is at least M)", f.VisualBlocks))
	}
	if len(f.ADRs) > 0 {
		M = append(M, fmt.Sprintf("ADR(s) %s (S has none)", strings.Join(f.ADRs, ", ")))
	}
	size := "S"
	switch {
	case len(L) > 0:
		size = "L"
	case len(M) > 0:
		size = "M"
	}
	return Required{size, map[string][]string{"L": L, "M": M}}
}

// Path is the planning path of a change: fast (Size S, Risk none, no sensitive path, no UI) or full.
type Path struct {
	Path    string   `json:"path"`
	Reasons []string `json:"reasons"`
	Review  bool     `json:"review"`
}

// PlanPath is the planning path of a change and whether it needs a final review.
func PlanPath(f Facts) Path {
	req := RequiredSize(f).Size
	size := req
	if f.Declared != "" && sizeOrder[f.Declared] >= sizeOrder[req] {
		size = f.Declared
	}
	ui := f.VisualBlocks > 0 || slices.ContainsFunc(f.Files, func(x string) bool { return testpaths.IsUIFile(x) && !testpaths.IsTestPath(x) })
	risk := len(f.Risk) > 0
	reasons := []string{}
	if f.Declared == "" {
		reasons = append(reasons, "no Size line")
	}
	if size != "S" {
		reasons = append(reasons, "Size: "+size)
	}
	if f.HasProposal && f.Risk == nil {
		reasons = append(reasons, "no Risk line")
	}
	if risk {
		reasons = append(reasons, "Risk: "+strings.Join(f.Risk, ", "))
	}
	if ui {
		reasons = append(reasons, "UI change")
	}
	var sens []string
	for _, x := range f.Files {
		if IsSensitivePath(x) {
			sens = append(sens, x)
		}
	}
	if len(sens) > 0 {
		reasons = append(reasons, "sensitive path: "+strings.Join(sens, ", "))
	}
	if f.Upgrade != nil {
		reasons = append(reasons, f.Upgrade.Reasons...)
	}
	p := "fast"
	if len(reasons) > 0 {
		p = "full"
	}
	return Path{p, reasons, size != "S" || risk || ui}
}

// PathArtifactProblems lists what the full path is missing: design.md, an ADR record (adrs/none.md counts) and app-map.md.
func PathArtifactProblems(f Facts, p Path) []Finding {
	if p.Path == "fast" || !f.HasProposal || f.Declared == "" || f.IsSlice || f.SpecOnly {
		return nil
	}
	var miss []string
	if !f.HasAppMap {
		miss = append(miss, "app-map.md")
	}
	if !f.HasDesign {
		miss = append(miss, "design.md")
	}
	if !f.HasADRFile {
		miss = append(miss, "adrs/none.md (or the ADRs)")
	}
	if len(miss) == 0 {
		return nil
	}
	return []Finding{{File: "proposal.md", Line: 1, Severity: "error", Kind: "path-artifacts", Text: fmt.Sprintf("full planning path (%s): missing %s. Write them (a Size S change keeps them to a few lines); only Size S + Risk none + no sensitive path + no UI skips them", strings.Join(p.Reasons, "; "), strings.Join(miss, ", "))}}
}

// SizeResult is the outcome of SizeCheck.
type SizeResult struct {
	Declared string              `json:"declared"`
	Required string              `json:"required"`
	Reasons  map[string][]string `json:"reasons"`
	Path     Path                `json:"path"`
	Problems []Finding           `json:"problems"`
}

var (
	decisionsRE = regexp.MustCompile(`^decisions\b`)
	inventoryRE = regexp.MustCompile(`^capability inventory\b`)
)

// SizeCheck compares the declared size with the one the facts require.
func SizeCheck(f Facts) SizeResult {
	out := []Finding{}
	req := RequiredSize(f)
	declared := f.Declared
	if declared == "" {
		declared = f.TasksSize
	}
	line := max(f.DeclaredLine, 1)
	if f.Declared == "" && f.HasProposal {
		extra := ""
		if req.Size != "S" {
			extra = " (" + strings.Join(append(append([]string{}, req.Reasons["L"]...), req.Reasons["M"]...), "; ") + ")"
		}
		out = append(out, Finding{File: "proposal.md", Line: 1, Severity: "warning", Kind: "size", Text: fmt.Sprintf(`proposal.md has no "Size: S|M|L" line; by the specs this change is Size: %s%s`, req.Size, extra)})
	}
	if declared != "" && sizeOrder[declared] < sizeOrder[req.Size] {
		why := append([]string{}, req.Reasons["L"]...)
		if req.Size == "M" {
			why = append(why, req.Reasons["M"]...)
		}
		out = append(out, Finding{File: "proposal.md", Line: line, Severity: "error", Kind: "size-under", Text: fmt.Sprintf(`proposal.md declares Size: %s but the change needs Size: %s: %s. Change the line to "Size: %s" in proposal.md and write the full artifacts for %s: app-map (every section), design (every section), one ADR per significant decision (or adrs/none.md); task cap %d. Never remove a scenario or a visual block to fit a smaller size. Then run lint again.`, declared, req.Size, strings.Join(why, "; "), req.Size, req.Size, Caps[req.Size])})
	}
	if f.HasProposal && f.Risk == nil && f.Declared != "" {
		out = append(out, Finding{File: "proposal.md", Line: line, Severity: "warning", Kind: "risk", Text: fmt.Sprintf(`proposal.md has no "Risk:" line under Size: write "Risk: none" or the kinds that apply (%s); any risk makes the change Size: L`, strings.Join(Risks, ", "))})
	}
	if f.Risk != nil && len(f.Risk) == 0 && len(f.RiskWords) > 0 {
		out = append(out, Finding{File: "proposal.md", Line: line, Severity: "warning", Kind: "risk", Text: fmt.Sprintf("proposal.md says Risk: none but mentions %s. If the change handles security, money, a data migration, concurrency or a public API, declare it on the Risk: line (that makes it Size: L); otherwise ignore this warning", strings.Join(f.RiskWords, ", "))})
	}
	eff := req.Size
	if declared != "" && sizeOrder[declared] >= sizeOrder[req.Size] {
		eff = declared
	}
	if eff != "S" && !f.IsSlice {
		if f.DesignSections != nil && !slices.ContainsFunc(f.DesignSections, decisionsRE.MatchString) {
			out = append(out, Finding{File: "design.md", Line: 1, Severity: "error", Kind: "size-artifacts", Text: fmt.Sprintf(`Size: %s needs the full design.md: it has no "## Decisions" section (only Size: S may cut design.md to Implementation guide and Pitfalls)`, eff)})
		}
		if f.AppMapSections != nil && !slices.ContainsFunc(f.AppMapSections, inventoryRE.MatchString) {
			out = append(out, Finding{File: "app-map.md", Line: 1, Severity: "error", Kind: "size-artifacts", Text: fmt.Sprintf(`Size: %s needs the full app-map.md: it has no "## Capability inventory" section (only Size: S may cut the app map to two lines)`, eff)})
		}
	}
	pp := PlanPath(f)
	out = append(out, PathArtifactProblems(f, pp)...)
	return SizeResult{declared, req.Size, req.Reasons, pp, out}
}

// AppMapText is the two-line app map of a Size S change, built from its specs and proposal.
func AppMapText(changeDir, livingDir string) string {
	f := SizeFacts(changeDir, nil)
	proposal, _ := readIf(filepath.Join(changeDir, "proposal.md"))
	why := strings.TrimSpace(spaceRE.ReplaceAllString(StripComments(Section(proposal, whyRE)), " "))
	why = firstSentence(why)
	if why != "" && strings.ContainsRune(".!?", rune(why[len(why)-1])) {
		why = why[:len(why)-1]
	}
	why = cut(why, 140)
	if why == "" {
		why = "see proposal.md"
	}
	capName := "<capability>"
	if len(f.Capabilities) > 0 {
		capName = f.Capabilities[0]
	}
	var have []string
	for _, s := range SpecFiles(livingDir) {
		have = append(have, s.Cap)
	}
	fits := "a new app, no capability exists yet"
	if len(have) > 0 {
		fits = strings.Join(have[:min(8, len(have))], ", ")
		if len(have) > 8 {
			fits += ", ..."
		}
	}
	return fmt.Sprintf("This change: %s - %s\nFits: %s; deferred: nothing\n", capName, why, fits)
}

// firstSentence cuts t after the first . ! or ? that is followed by whitespace.
func firstSentence(t string) string {
	for i := 0; i+1 < len(t); i++ {
		if strings.ContainsRune(".!?", rune(t[i])) && (t[i+1] == ' ' || t[i+1] == '\t' || t[i+1] == '\n') {
			return t[:i+1]
		}
	}
	return t
}
