package greenfield

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Item is one gate item.
type Item struct {
	ID     string   `json:"id"`
	OK     bool     `json:"ok"`
	Text   string   `json:"text"`
	Detail []string `json:"detail"`
	Fix    *string  `json:"fix"`
}

// Gate is what "ready for handover" means.
type Gate struct {
	Ready    bool     `json:"ready"`
	Items    []Item   `json:"items"`
	Missing  []Item   `json:"missing"`
	Warnings []string `json:"warnings"`
	Roadmap  *Roadmap `json:"-"`
}

var (
	secretFileRE = regexp.MustCompile(`(?i)\.(md|ya?ml|json|txt|env)$`)
	envNameRE    = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,}$`)
	notSecretRE  = regexp.MustCompile(`(?i)^(?:env:|\$|\*+$|x+$|changeme|example|placeholder|redacted)`)
)

// secretScan lists file:line of what looks like a credential value (the value itself is never returned).
func (p *Project) secretScan(abs ...string) []string {
	var hits []string
	var walk func(a string)
	walk = func(a string) {
		if isDir(a) {
			for _, f := range ls(a, "") {
				walk(filepath.Join(a, f))
			}
			return
		}
		if !secretFileRE.MatchString(a) {
			return
		}
		t, _ := read(a)
		for i, l := range strings.Split(t, "\n") {
			if m := secretRE.FindStringSubmatch(l); m != nil && !envNameRE.MatchString(m[2]) && !notSecretRE.MatchString(m[2]) {
				hits = append(hits, fmt.Sprintf("%s:%d", p.Rel(a), i+1))
			}
		}
	}
	for _, a := range abs {
		walk(a)
	}
	return hits
}

func (p *Project) inputFiles() []string {
	var out []string
	var walk func(d, rel string)
	walk = func(d, rel string) {
		for _, f := range ls(d, "") {
			a := filepath.Join(d, f)
			if isDir(a) {
				walk(a, rel+f+"/")
			} else if rel != "" || f != "README.md" {
				out = append(out, rel+f)
			}
		}
	}
	walk(p.path("inputs"), "")
	return out
}

func joinIDs[T any](l []T, f func(T) string) []string {
	var out []string
	for _, x := range l {
		out = append(out, f(x))
	}
	return out
}

// Gate runs every handover check.
func (p *Project) Gate() *Gate {
	g := &Gate{Items: []Item{}, Missing: []Item{}, Warnings: []string{}}
	add := func(id string, ok bool, text string, detail []string, fix string) {
		it := Item{ID: id, OK: ok, Text: text, Detail: []string{}}
		if !ok {
			if detail != nil {
				it.Detail = detail
			}
			it.Fix = &fix
		}
		g.Items = append(g.Items, it)
	}
	rel := func(parts ...string) string { return p.Rel(p.path(parts...)) }
	qs, as, caps, us := p.questions(), p.assumptions(), p.capabilities(), p.understoodState()
	add("inputs", len(p.inputFiles()) >= 1, "client inputs are in "+rel("inputs")+"/", []string{rel("inputs") + "/ has no files besides README.md"},
		"Put the client material into "+rel("inputs")+"/, then run /spec-green-start.")
	var ud []string
	switch {
	case !us.Exists:
		ud = us.Problems
	case us.Stale:
		ud = append(slices.Clone(us.Problems), "it changed after the approval")
	case us.Approved:
		ud = us.Problems
	default:
		ud = append(slices.Clone(us.Problems), "not approved yet")
	}
	add("understood", us.Approved, `"what we understood" approved by the client`, ud, "Run /spec-green-start (it writes the page and asks for the approval).")
	var qd []string
	for _, q := range qs {
		if q.Blocking && (q.Status == "open" || q.Status == "asked") {
			qd = append(qd, fmt.Sprintf("%s is %s (owner: %s)", q.ID, q.Status, q.Owner))
		}
	}
	for _, t := range Topics {
		if !slices.ContainsFunc(qs, func(q question) bool { return q.Topic == t.Name }) {
			qd = append(qd, fmt.Sprintf("no question file for topic '%s'", t.Name))
		}
	}
	for _, a := range as {
		if len(a.Bad) > 0 {
			qd = append(qd, fmt.Sprintf("%s: missing %s", a.ID, strings.Join(a.Bad, ", ")))
		}
	}
	for _, q := range qs {
		if q.Status == "assumed" && !slices.ContainsFunc(as, func(a assumption) bool { return a.From == q.ID }) {
			qd = append(qd, q.ID+" is assumed but has no assumption file")
		}
	}
	add("questions", len(qd) == 0, "every question is answered, assumed with an owner, or not applicable", qd, "Run /spec-green-start and follow its Next line.")
	var inv []string
	for _, a := range as {
		if a.Status == "invalidated" {
			inv = append(inv, a.ID+": "+a.Replan)
		}
	}
	add("assumptions", len(inv) == 0, "no assumption is invalidated (an invalidated assumption triggers a re-plan)", inv,
		"Update the affected specs and slices, then set the assumption status to verified or remove it.")
	sp := p.specProblems()
	nreq := p.living().Len()
	if len(sp) == 0 {
		sp = []string{"there are no requirements"}
	}
	add("requirements", len(p.specProblems()) == 0 && nreq > 0, "every requirement has testable scenarios (WHEN/THEN) and a Why (who wants it, and why)", sp,
		"Fix the listed requirements with a spec-only change.")
	var ns []string
	for _, c := range caps {
		if !p.hasLiving(c.Cap) {
			ns = append(ns, fmt.Sprintf("%s has no %s", c.Cap, p.Rel(filepath.Join(p.Root.LivingSpecs(), c.Cap+".md"))))
		}
	}
	cd := ns
	if len(caps) == 0 {
		cd = []string{"no capability files"}
	}
	add("capabilities", len(caps) >= 1 && len(ns) == 0, "every capability in the map has its spec", cd, "Run /spec-green-start (Capabilities phase).")
	var ip []string
	for _, c := range caps {
		if c.Kind != "integration" {
			continue
		}
		if isPlaceholder(c.Sandbox) {
			ip = append(ip, c.Cap+": no sandbox (test endpoint, sample data, who provides access) in its capability file")
		}
		if p.hasLiving(c.Cap) {
			ip = append(ip, contractProblems(c.Cap, p.livingSpec(c.Cap))...)
		}
	}
	add("integrations", len(ip) == 0, "every integration has a contract, 2+ failure scenarios and sandbox data", ip,
		"Fix with a spec-only change (see the integration-contract template: wingman-spec instructions specs).")
	var np []string
	if p.hasLiving(NFRCap) {
		np = nfrProblems(p.livingSpec(NFRCap))
	} else {
		np = []string{p.Rel(filepath.Join(p.Root.LivingSpecs(), NFRCap+".md")) + " does not exist"}
	}
	add("nfr", len(np) == 0, "non-functional requirements are measurable", np, "Fix with a spec-only change; every NFR needs a number and a unit.")
	add("glossary", p.glossaryTerms() >= 3, "glossary has at least 3 terms", []string{rel("glossary.md") + ` needs "- **Term**: meaning" lines`}, "Write "+rel("glossary.md")+".")
	add("adrs", len(p.adrFiles()) >= 1, "architecture decisions are recorded ("+p.Rel(p.Root.ADRs())+"/)", []string{p.Rel(p.Root.ADRs()) + "/ has no decision"},
		"Record the fixed decisions as ADRs in the foundation change.")
	add("environments", p.usableEnvs() >= 1, "environments, access owners and roles are written down (names only, no secrets)",
		[]string{"no " + p.Rel(p.G(records)) + "/ENV-<name>.md with `access:` and `roles:`"}, "Run: "+Run+" greenfield new environment <name>, then fill it in.")
	hits := p.secretScan(p.G(), p.Root.LivingSpecs(), p.path("roadmap"), p.Root.ADRs(), p.path("glossary.md"))
	add("no-secrets", len(hits) == 0, "no credentials in the spec files",
		joinIDs(hits, func(h string) string {
			return h + " looks like a credential value; name the secret instead (e.g. PAYMENTS_API_KEY) and say who provides it"
		}), "Remove the value, rotate the credential if it was real.")
	rv := p.reviewOf("spec")
	has, cur := p.signoffCurrent()
	add("spec-review", rvOK(rv), "an independent reviewer passed the spec (score 80+, no blockers)", reviewDetail(rv, "no review recorded", "the specs changed after the review", true),
		"Run /spec-green-start (Review phase).")
	sd := []string{"no sign-off recorded"}
	if has {
		sd = []string{"the specs changed after the sign-off"}
	}
	add("signoff", has && cur, "the client signed off the reviewed spec", sd, `Run: `+Run+` greenfield approve spec --by "<name>" after the client agrees.`)
	rm := p.Roadmap()
	g.Roadmap = rm
	rd := joinIDs(rm.Errors, func(e Issue) string { return e.Text })
	if len(rm.Slices) == 0 {
		rd = []string{"no slices in " + rel("roadmap") + "/"}
	}
	add("roadmap", len(rm.Slices) > 0 && rm.OK, "the roadmap is valid (no cycles, skeleton first, every requirement covered, sizes within caps)", rd, "Run /spec-green-plan.")
	pr, dr := p.reviewOf("plan"), p.reviewOf("dryrun")
	add("plan-review", rvOK(pr), "an independent reviewer passed the plan", reviewDetail(pr, "no plan review recorded", "the plan changed after the review", true), "Run /spec-green-start (Roadmap phase).")
	add("dry-run", rvOK(dr), "an implementability dry-run found no blocking unknowns", reviewDetail(dr, "no dry-run recorded", "the plan or specs changed after the dry-run", false), "Run /spec-green-start (Roadmap phase).")
	if ih := p.secretScan(p.path("inputs")); len(ih) > 0 {
		g.Warnings = append(g.Warnings, fmt.Sprintf("%s has what looks like credential value(s) (%s): keep them out of the repository", rel("inputs"), strings.Join(ih[:min(3, len(ih))], ", ")))
	}
	for _, x := range []struct {
		r    *review
		name string
	}{{rv, "spec review"}, {pr, "plan review"}, {dr, "dry-run"}} {
		if x.r != nil && x.r.Verdict == "waived" {
			g.Warnings = append(g.Warnings, x.name+" waived: "+or(x.r.Data.Str("reason"), "no reason"))
		}
	}
	for _, it := range g.Items {
		if !it.OK {
			g.Missing = append(g.Missing, it)
		}
	}
	g.Ready = len(g.Missing) == 0
	return g
}

func fmtScore(s float64) string { return fmt.Sprintf("%g", s) }

func reviewDetail(r *review, none, stale string, score bool) []string {
	switch {
	case r == nil:
		return []string{none}
	case !r.Current:
		return []string{stale}
	case score:
		return []string{fmt.Sprintf("verdict %s, score %s", r.Verdict, fmtScore(r.Score))}
	}
	return []string{"verdict " + r.Verdict}
}
