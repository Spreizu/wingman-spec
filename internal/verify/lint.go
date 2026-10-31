package verify

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/trace"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

// Ambig is an ambiguous checkbox of tasks.md.
type Ambig struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func (e *Env) lintReport(files []string) []Ambig {
	out := []Ambig{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, a := range tasks.AmbiguousLines(string(b)) {
			out = append(out, Ambig{e.findingFile("", f), a.Line, a.Kind, a.Text})
		}
	}
	return out
}

// VProblem is a finding of the visual lint (the helper's shape, kept as is).
type VProblem map[string]any

func (p VProblem) severity() string { s, _ := p["severity"].(string); return s }

type vlint struct {
	scenarios []*visual.Scenario
	problems  []VProblem
}

// visualLint: scenario blocks, Visual: lines and design-map rows of a change (through the visual helper).
func (e *Env) visualLint(changeDir string) vlint {
	if !visual.HasBlocks(filepath.Join(changeDir, "specs")) {
		var out vlint
		// Visual: lines that name scenarios when the change has none.
		for _, t := range tasks.Parse(readText(tasksFile(changeDir))).All() {
			r := visualRefs(t.Detail)
			for _, u := range r.ids {
				out.problems = append(out.problems, VProblem{"file": e.findingFile(changeDir, tasksFile(changeDir)), "line": t.Line, "kind": "visual-ref", "severity": "error",
					"text": fmt.Sprintf("tasks.md:%d: Visual: names %q, which is not a visual scenario of this change (known: none)", t.Line, u)})
			}
		}
		return out
	}
	scens := visual.ParseScenarios(filepath.Join(changeDir, "specs"))
	var probs []VProblem
	for _, p := range visual.LintScenarios(scens, changeDir, e.R.Specs, e.code, e.Cfg.Visual) {
		probs = append(probs, p)
	}
	probs = append(probs, e.visualLineLint(changeDir, scens)...)
	if visual.NeedsDesignLint(scens) {
		// The design lint (design-map.md rows, token names) reads the project's design system: the helper does it.
		var res struct {
			Problems []VProblem `json:"problems"`
		}
		if err := visual.Call(e.Ctx, e.code, "design-lint", map[string]any{"scenarios": scens, "change_dir": changeDir, "root": e.R.Specs, "code_root": e.code}, &res, nil); err != nil {
			e.say("WARNING: the design map was not linted: %v", err)
			probs = append(probs, VProblem{"kind": "visual-helper", "severity": "warning", "text": "the design map was not linted: " + err.Error()})
		} else {
			probs = append(probs, res.Problems...)
		}
	}
	for _, p := range visual.ExpectScopeLint(scens, e.R.Specs) {
		probs = append(probs, p)
	}
	for _, s := range scens {
		if s.Component == "" && len(s.Errors) == 0 {
			probs = append(probs, VProblem{"file": s.File, "line": s.Line, "kind": "visual-component", "severity": "info", "scenario": s.ID,
				"text": fmt.Sprintf("%s:%d: visual scenario %s has no component: line, so no task may change it. Add \"component: <file name>\" so a task that lists that file in Files: may change it", specRel(e.R.Specs, s.File), s.Line, s.ID)})
		}
	}
	for _, p := range probs {
		if f, ok := p["file"].(string); ok {
			p["file"] = e.findingFile(changeDir, f)
		}
	}
	return vlint{scenarios: scens, problems: list(probs)}
}

var testidRE = regexp.MustCompile(`data-testid\s*=\s*["']?([\w-]+)`)

// visualLineLint: the Visual: lines of tasks.md against the change's scenarios: unknown names (error), a scenario named
// before the task that builds its elements (error) or its component (info), and scenarios no task names (warning).
func (e *Env) visualLineLint(changeDir string, scens []*visual.Scenario) []VProblem {
	f := tasksFile(changeDir)
	if !exists(f) {
		return nil
	}
	var out []VProblem
	type tl struct {
		line        int
		label, text string
		review      bool
		files       []string
		found       []*visual.Scenario
	}
	var ts []tl
	used := map[string]bool{}
	anyAll := false
	known := ids(scens)
	for _, t := range tasks.Parse(readText(f)).All() {
		r := visualRefs(t.Detail)
		anyAll = anyAll || r.all
		found, unknown := resolveRefs(r, scens)
		for _, s := range found {
			used[s.ID] = true
		}
		for _, u := range unknown {
			k := strings.Join(known, ", ")
			if k == "" {
				k = "none"
			}
			out = append(out, VProblem{"file": f, "line": t.Line, "kind": "visual-ref", "severity": "error",
				"text": fmt.Sprintf("tasks.md:%d: Visual: names %q, which is not a visual scenario of this change (known: %s)", t.Line, u, k)})
		}
		text := []string{t.Label, t.Title}
		for _, d := range t.Detail {
			if !visualLineRE.MatchString(d) {
				text = append(text, d)
			}
		}
		label := t.Label
		if label == "" {
			label = t.Title
		}
		if r.all {
			found = nil
		}
		ts = append(ts, tl{t.Line, label, strings.Join(text, " "), t.Review || tasks.IsReview(t.Label, t.Title), filesOf(t.Detail), found})
	}
	var work []tl
	for _, t := range ts {
		if !t.review {
			work = append(work, t)
		}
	}
	mentions := func(xs []tl, id string) int {
		for i, x := range xs {
			if strings.Contains(x.text, id) {
				return i
			}
		}
		return -1
	}
	touches := func(xs []tl, comp string) bool {
		for _, x := range xs {
			for _, fl := range x.files {
				if strings.HasPrefix(strings.ToLower(filepath.Base(fl)), comp) {
					return true
				}
			}
		}
		return false
	}
	for i, t := range work {
		upto, later := work[:i+1], work[i+1:]
		for _, sc := range t.found {
			var tids []string
			for _, k := range sc.AllKeys() {
				for _, m := range testidRE.FindAllStringSubmatch(k, -1) {
					if !slices.Contains(tids, m[1]) {
						tids = append(tids, m[1])
					}
				}
			}
			var late []string
			for _, id := range tids {
				if mentions(later, id) >= 0 && mentions(upto, id) < 0 {
					late = append(late, id)
				}
			}
			if len(late) > 0 {
				by := ""
				for _, x := range later {
					if slices.ContainsFunc(late, func(id string) bool { return strings.Contains(x.text, id) }) {
						by = x.label
						break
					}
				}
				sels := make([]string, len(late))
				for k, id := range late {
					sels[k] = fmt.Sprintf("[data-testid=%q]", id)
				}
				them := "it"
				if len(late) > 1 {
					them = "them"
				}
				out = append(out, VProblem{"file": f, "line": t.line, "kind": "visual-order", "severity": "error",
					"text": fmt.Sprintf("tasks.md:%d: task %s names visual scenario %s, which checks %s; only the later task %s mentions %s, so the check would fail (or block) here. Name %s in the Visual: line of the task that completes it (%s), or move those elements into %s", t.line, t.label, sc.ID, strings.Join(sels, ", "), by, them, sc.ID, by, t.label)})
				continue
			}
			if comp := strings.ToLower(sc.Component); comp != "" && !touches(upto, comp) && touches(later, comp) {
				out = append(out, VProblem{"file": f, "line": t.line, "kind": "visual-order", "severity": "info",
					"text": fmt.Sprintf("tasks.md:%d: task %s names visual scenario %s (component: %s), but only a later task's Files: touches %s; name the scenario from that task", t.line, t.label, sc.ID, sc.Component, sc.Component)})
			}
		}
	}
	if !anyAll {
		for _, s := range scens {
			if !used[s.ID] {
				out = append(out, VProblem{"file": s.File, "line": s.Line, "kind": "visual-coverage", "severity": "warning", "scenario": s.ID,
					"text": fmt.Sprintf("%s:%d: visual scenario %s is not named by any task's Visual: line, so no task checks it", specRel(e.R.Specs, s.File), s.Line, s.ID)})
			}
		}
	}
	return out
}

func (e *Env) planProblems(changeDir string) []quality.Finding {
	out := []quality.Finding{}
	f := tasksFile(changeDir)
	b, err := os.ReadFile(f)
	if err != nil {
		return out
	}
	opts := quality.PlanOpts{}
	if p := filepath.Join(changeDir, "proposal.md"); exists(p) {
		opts.Size = quality.ReadProposalSize(readText(p)).Size
		if opts.Size != "" {
			r := quality.PlanPath(quality.SizeFacts(changeDir, e.readUpgrade())).Review
			opts.Review = &r
		}
	}
	for _, p := range quality.PlanLint(string(b), opts).Problems {
		p.File = f
		p.Text = fmt.Sprintf("tasks.md:%d: %s", p.Line, p.Text)
		out = append(out, p)
	}
	return out
}

type sizeRep struct {
	quality.SizeResult
	facts quality.Facts
}

func (e *Env) sizeReport(changeDir string) sizeRep {
	f := quality.SizeFacts(changeDir, e.readUpgrade())
	r := quality.SizeCheck(f)
	ps := []quality.Finding{}
	for _, p := range r.Problems {
		rel := p.File
		p.File = filepath.Join(changeDir, rel)
		p.Text = fmt.Sprintf("%s:%d: %s", rel, p.Line, p.Text)
		ps = append(ps, p)
	}
	r.Problems = ps
	return sizeRep{r, f}
}

type whyRep struct {
	mode string
	trace.WhyResult
}

func asProblem(p trace.Problem) trace.Problem {
	if p.Kind != "missing-why" && p.Kind != "why-too-short" && p.File != "" && p.Line > 0 {
		p.Text = fmt.Sprintf("%s:%d: %s", p.File, p.Line, p.Text)
	}
	return p
}

func (e *Env) whyReport(changeDir string) whyRep {
	md := trace.Mode(e.Cfg)
	r := e.tr().WhyLint(changeDir)
	ps := []trace.Problem{}
	for _, p := range trace.BySeverity(r.Problems, md) {
		ps = append(ps, asProblem(p))
	}
	r.Problems = ps
	return whyRep{md, r}
}

var sliceRE = regexp.MustCompile("(?mi)^\\s*(?:[-*]\\s+)?\\**Slice\\**:\\s*`?([a-z0-9][a-z0-9-]*)`?")

func sliceProblems(changeDir string) []quality.Finding {
	m := sliceRE.FindStringSubmatch(readText(filepath.Join(changeDir, "proposal.md")))
	if m == nil {
		return nil
	}
	if ents, _ := os.ReadDir(filepath.Join(changeDir, "specs")); len(ents) > 0 {
		return []quality.Finding{{Line: 1, Severity: "error", Kind: "slice-with-specs", File: "proposal.md", Text: fmt.Sprintf("slice %s: a slice change builds what the specs already say; it carries no specs/ delta (amend the specs with a separate change first)", m[1])}}
	}
	return nil
}

// PlanFinding is any finding of the plan section of lint (quality and traceability shapes).
type PlanFinding struct {
	File     string `json:"file,omitempty"`
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
}

func pf[T quality.Finding | trace.Problem](xs []T, wrap func(*PlanFinding)) []PlanFinding {
	var out []PlanFinding
	for _, x := range xs {
		var p PlanFinding
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &p)
		if wrap != nil {
			wrap(&p)
		}
		out = append(out, p)
	}
	return out
}

type planRep struct {
	sz   sizeRep
	edge []quality.EdgeItem
	why  whyRep
	plan []PlanFinding
}

func visualMap(scens []*visual.Scenario) (map[string]quality.VisualScenario, []string) {
	m := map[string]quality.VisualScenario{}
	var ids []string
	for _, s := range scens {
		var vs quality.VisualScenario
		for _, st := range s.States {
			keys := []any{}
			for _, k := range st.Keys {
				keys = append(keys, k)
			}
			vs.States = append(vs.States, quality.VisualState{Name: st.Name, Keys: keys})
		}
		m[s.ID] = vs
		ids = append(ids, s.ID)
	}
	return m, ids
}

func (e *Env) planReport(changeDir string, vl vlint) planRep {
	sz := e.sizeReport(changeDir)
	vm, vids := visualMap(vl.scenarios)
	ui := len(vids) > 0 || len(quality.TaskUIFiles(changeDir, e.Cfg.Visual.UIFiles...)) > 0
	edgeItems, edgeProbs := quality.EdgeLint(changeDir, e.R.LivingSpecs(), vm, ui)
	nr := e.whyReport(changeDir)
	inv := pf(quality.InvariantLint(filepath.Join(changeDir, "specs")), nil)
	purpose := pf(append(quality.PurposeLint(changeDir, e.R.LivingSpecs()), quality.ThenLint(changeDir)...), nil)
	inChange := func(p *PlanFinding) {
		if p.File != "" {
			p.File = filepath.Join(changeDir, p.File)
		}
	}
	ux := pf(append(quality.UXLint(changeDir, vids), quality.VisualGapLint(changeDir, ui)...), inChange)
	var plan []PlanFinding
	if trace.IsSpecOnly(changeDir) {
		plan = slices.Concat(pf(nr.Problems, nil), inv, purpose, ux)
	} else {
		plan = slices.Concat(pf(sz.Problems, nil), pf(nr.Problems, nil), pf(e.planProblems(changeDir), nil), inv, pf(edgeProbs, inChange), purpose, ux, pf(sliceProblems(changeDir), nil))
	}
	for i := range plan {
		plan[i].File = e.findingFile(changeDir, plan[i].File)
	}
	return planRep{sz, edgeItems, nr, list(plan)}
}

// findingFile is the file of a lint finding as every lint output shows it: relative to the code root, with forward
// slashes (absolute only when it lies outside the code root, e.g. in a separate specs repository). A relative path
// from a checker is relative to the change directory when that file exists there, else to the code root.
func (e *Env) findingFile(changeDir, f string) string {
	if f == "" {
		return ""
	}
	if !filepath.IsAbs(f) {
		if a := filepath.Join(changeDir, f); exists(a) {
			f = a
		} else {
			f = filepath.Join(e.code, f)
		}
	}
	return filepath.ToSlash(rel(e.code, f))
}

func capOf(size string) any {
	if c, ok := quality.Caps[size]; ok {
		return c
	}
	return nil
}

// Lint is the planning lint of a change (no command runs).
func (e *Env) Lint() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	files := []string{tasksFile(changeDir)}
	bad := e.lintReport(files)
	vl := e.visualLint(changeDir)
	config := []string{}
	if p := testCmdProblem(e.testCmd()); p != "" {
		config = append(config, p)
	}
	if len(vl.scenarios) > 0 {
		if p := visual.ConfigProblem(e.Cfg.Visual); p != "" {
			config = append(config, p)
		}
	}
	pr := e.planReport(changeDir, vl)
	visualBad := slices.ContainsFunc(vl.problems, func(p VProblem) bool { return p.severity() != "info" && p["kind"] != "visual-helper" })
	ok := len(bad) == 0 && len(config) == 0 && !visualBad && !slices.ContainsFunc(pr.plan, func(p PlanFinding) bool { return p.Severity == "error" })
	sz := pr.sz
	size := sz.Declared
	if size == "" {
		size = sz.Required
	}
	var approvals any = Skip
	if pr.why.mode != "off" {
		ks := []string{}
		for _, a := range pr.why.Approvals {
			ks = append(ks, a.Key)
		}
		approvals = ks
	}
	edge := []any{}
	for _, x := range pr.edge {
		edge = append(edge, O("text", x.Text, "scenarios", list(x.IDs)))
	}
	e.print(O("ok", ok, "traceability", pr.why.mode, "why_owner_approval", approvals,
		"size", O("declared", orNil(sz.Declared), "required", orNil(sz.Required), "task_cap", capOf(size)),
		"edge_cases", edge, "problems", bad, "visual", list(vl.problems), "visual_scenarios", ids(vl.scenarios), "plan", pr.plan, "config", config))
	if ok {
		return nil
	}
	return quit(Fail)
}

// Size compares the declared size with what the change needs.
func (e *Env) Size() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	r := e.sizeReport(changeDir)
	f := r.facts
	so := trace.IsSpecOnly(changeDir)
	ok := so || !slices.ContainsFunc(r.Problems, func(p quality.Finding) bool { return p.Severity == "error" })
	size := r.Declared
	if size == "" {
		size = r.Required
	}
	e.print(O("ok", ok, "kind", If(so, "spec-only"), "declared", orNil(r.Declared), "required", orNil(r.Required), "path", r.Path.Path, "path_reasons", list(r.Path.Reasons),
		"review_required", r.Path.Review, "reasons", r.Reasons, "task_cap", capOf(size),
		"facts", O("capabilities", list(f.Capabilities), "requirements", f.Requirements, "visual_blocks", f.VisualBlocks, "breaking", f.Breaking, "risk", list(f.Risk), "risky_groups", list(f.RiskyGroups), "adrs", list(f.ADRs)),
		"problems", list(r.Problems)))
	if ok {
		return nil
	}
	return quit(Fail)
}

// AppMap writes (--apply) or prints the two-line app map of a Size S change.
func (e *Env) AppMap() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	f := quality.SizeFacts(changeDir, nil)
	if !f.HasProposal || f.Declared != "S" {
		return die(Usage, "app-map is generated only for a Size S change: M and L write the full app map")
	}
	text := quality.AppMapText(changeDir, e.R.LivingSpecs())
	if e.O.Apply {
		if err := os.WriteFile(filepath.Join(changeDir, "app-map.md"), []byte(text), 0o644); err != nil {
			return die(Fail, "cannot write app-map.md: %v", err)
		}
	}
	e.print(O("ok", true, "written", e.O.Apply, "text", text))
	return nil
}

// specRel is f relative to the specs root (the form the visual findings name files in).
func specRel(root, f string) string {
	if r, err := filepath.Rel(root, f); err == nil {
		return r
	}
	return f
}
