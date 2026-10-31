package greenfield

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

// Phases in order.
var Phases = []string{"Inputs", "Questions", "Foundation", "Capabilities", "Review", "Roadmap", "Handover"}

// Topics are the fixed question topics, in order, with their question.
var Topics = []struct{ Name, Text string }{
	{"users", "Who are the users and operators of the product? For each role: what they must achieve, how often, on which devices or channels, and what they must NOT be able to do."},
	{"goals", "What is the product for, and how will we know it works? List the 3 to 7 outcomes that matter (what users want, and why) and a measurable success target for each."},
	{"integrations", "Which external systems must it talk to (payments, identity, notifications, ERP, data feeds)? For each: purpose, direction, who owns it, sandbox or test access, sample data."},
	{"failure", "What must happen when things go wrong: an external system is down or slow, invalid input, a double submit, a partial failure, lost data? Per integration: retry, fallback, what the user sees."},
	{"nfr", "Numeric targets: response times, throughput and users, availability, data volume and retention, security and privacy rules, accessibility, supported browsers and devices."},
	{"constraints", "Fixed technology, hosting, budget, deadlines, legal or regulatory rules, existing systems and data to reuse, team skills."},
	{"out-of-scope", "What is explicitly NOT part of this product or of the first release? What may be asked for later but must not be built now?"},
	{"environments", "Which environments exist (dev, test, staging, prod)? Who provides access and credentials (names of secrets only, never values), and which roles or test accounts are needed?"},
	{"design", "Is there a design to match (Figma URL, mockups, brand guide), or is the UI freeform? Where are the files, and who decides design questions?"},
}

func topicText(t string) string {
	for _, x := range Topics {
		if x.Name == t {
			return x.Text
		}
	}
	return ""
}

// NFRCap is the capability that holds the non-functional requirements.
const NFRCap = "non-functional-requirements"

const (
	skeletonMaxReq = 5
	records        = "records"
)

var sizeReqCap = map[string]int{"S": 3, "M": 6, "L": 10}

var (
	secretRE      = regexp.MustCompile(`(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'<>{}$` + "`" + `]{8,})`)
	placeholderRE = regexp.MustCompile(`^<.*>$|^$`)
	answerHeadRE  = regexp.MustCompile(`(?i)^answer\b`)
)

func isPlaceholder(s string) bool { return placeholderRE.MatchString(strings.TrimSpace(s)) }

type record struct {
	ID, File, Body string
	Data           FM
}

func (p *Project) files(dir, prefix string) []record {
	var out []record
	for _, f := range ls(p.G(dir), ".md") {
		if prefix != "" && !strings.HasPrefix(f, prefix) {
			continue
		}
		d, body, _ := parseFM(readS(p.G(dir, f)))
		out = append(out, record{strings.TrimSuffix(f, ".md"), p.G(dir, f), body, d})
	}
	return out
}

type question struct {
	record
	Topic, Status, Declared, Owner, Answer string
	Blocking                               bool
}

func or(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func (p *Project) questions() []question {
	var out []question
	for _, q := range p.files(records, "Q-") {
		st := strings.ToLower(or(q.Data.Str("status"), "open"))
		ans := strings.TrimSpace(stripComments(section(q.Body, answerHeadRE)))
		n := len([]rune(ans))
		filled := n >= 15
		if st == "n/a" {
			filled = n >= 10
		}
		eff := st
		if (st == "answered" || st == "n/a") && !filled {
			eff = "open"
		}
		out = append(out, question{q, q.Data.Str("topic"), eff, st, or(q.Data.Str("owner"), "client"), ans,
			strings.ToLower(or(q.Data.Str("blocking"), "yes")) != "no"})
	}
	return out
}

type assumption struct {
	record
	Status, Owner, From, VerifyBy, Replan string
	Bad                                   []string
}

func (p *Project) assumptions() []assumption {
	var out []assumption
	for _, a := range p.files(records, "A-") {
		var bad []string
		for _, k := range []string{"owner", "verify_by", "replan_trigger", "from"} {
			if isPlaceholder(a.Data.Str(k)) {
				bad = append(bad, k)
			}
		}
		out = append(out, assumption{a, strings.ToLower(or(a.Data.Str("status"), "open")), a.Data.Str("owner"), a.Data.Str("from"),
			a.Data.Str("verify_by"), a.Data.Str("replan_trigger"), bad})
	}
	return out
}

type capability struct {
	record
	Cap, Kind, Priority, Sandbox string
	Risk                         []string
}

func (p *Project) capabilities() []capability {
	var out []capability
	for _, c := range p.files("capabilities", "") {
		kind := "capability"
		if c.Data.Str("kind") == "integration" {
			kind = "integration"
		}
		var risk []string
		for _, x := range c.Data.List("risk") {
			if x != "" && x != "none" {
				risk = append(risk, x)
			}
		}
		out = append(out, capability{c, c.ID, kind, or(c.Data.Str("priority"), "P1"), c.Data.Str("sandbox"), risk})
	}
	slices.SortStableFunc(out, func(a, b capability) int {
		if x := natural(a.Priority, b.Priority); x != 0 {
			return x
		}
		return natural(a.Cap, b.Cap)
	})
	return out
}

func (p *Project) capByName(n string) *capability {
	for _, c := range p.capabilities() {
		if c.Cap == n {
			return &c
		}
	}
	return nil
}

type environment struct {
	record
	Name string
}

func (p *Project) environments() []environment {
	var out []environment
	for _, e := range p.files(records, "ENV-") {
		out = append(out, environment{e, e.ID[4:]})
	}
	return out
}

func (p *Project) usableEnvs() int {
	n := 0
	for _, e := range p.environments() {
		if !isPlaceholder(e.Data.Str("access")) && len(e.Data.List("roles")) > 0 {
			n++
		}
	}
	return n
}

var explorationSections = []*regexp.Regexp{regexp.MustCompile(`(?i)^capability map\b`), regexp.MustCompile(`(?i)^integration inventory\b`)}

var understoodSections = []struct {
	Name string
	RE   *regexp.Regexp
}{
	{"Product in one paragraph", regexp.MustCompile(`(?i)^product\b`)},
	{"Users and what they need", regexp.MustCompile(`(?i)^users\b`)},
	{"What it must do", regexp.MustCompile(`(?i)^what it must do\b`)},
	{"Systems it connects to", regexp.MustCompile(`(?i)^systems\b`)},
	{"What happens when things fail", regexp.MustCompile(`(?i)^what happens when things fail\b`)},
	{"Targets", regexp.MustCompile(`(?i)^targets\b`)},
	{"Out of scope", regexp.MustCompile(`(?i)^out of scope\b`)},
	{"Assumptions we made", regexp.MustCompile(`(?i)^assumptions\b`)},
	{"Still open", regexp.MustCompile(`(?i)^still open\b`)},
}

// hashDir hashes files and folders below the specs root (paths relative to it), line endings normalized.
func (p *Project) hashDir(rels ...string) string {
	var h []string
	var walk func(abs, rel string)
	walk = func(abs, rel string) {
		if isDir(abs) {
			for _, f := range ls(abs, "") {
				walk(filepath.Join(abs, f), rel+"/"+f)
			}
		} else if t, ok := read(abs); ok {
			h = append(h, rel+"\n"+strings.ReplaceAll(t, "\r\n", "\n"))
		}
	}
	for _, r := range rels {
		walk(p.path(r), r)
	}
	slices.Sort(h)
	return sha(strings.Join(h, "\n--\n"))
}

func (p *Project) specHash() string {
	return p.hashDir("specs", "adrs", "glossary.md", "greenfield/capabilities")
}

func (p *Project) planHash() string { return sha(p.specHash() + p.hashDir("roadmap")) }

type understood struct {
	Exists, Approved, Stale bool
	Problems                []string
	Hash, ApprovedBy        string
}

var (
	wsRE          = regexp.MustCompile(`\s+`)
	codeSpanRE    = regexp.MustCompile("`[^`]*`")
	placeholderIn = regexp.MustCompile(`(?i)<fill in|\bTODO\b|<[a-z][^>]*>`)
)

func nonBlank(s string) int {
	n := 0
	for l := range strings.SplitSeq(s, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

func (p *Project) understoodState() understood {
	t, ok := read(p.G("understood.md"))
	if !ok {
		return understood{Problems: []string{p.Rel(p.G("understood.md")) + " does not exist"}}
	}
	d, b, _ := parseFM(t)
	body := stripComments(b)
	var probs []string
	if n := nonBlank(body); n > 80 {
		probs = append(probs, fmt.Sprintf(`it is %d lines: keep "what we understood" to one page (80 lines)`, n))
	}
	for _, s := range understoodSections {
		if !hasH2(body, s.RE) {
			probs = append(probs, `missing section "## `+s.Name+`"`)
		}
	}
	var need []string
	for _, a := range p.assumptions() {
		need = append(need, a.ID)
	}
	for _, q := range p.questions() {
		if !q.Blocking && (q.Status == "open" || q.Status == "asked") {
			need = append(need, q.ID)
		}
	}
	caps := p.capabilities()
	var capNames []string
	for _, c := range caps {
		need = append(need, c.Cap)
		capNames = append(capNames, c.Cap)
	}
	low := strings.ToLower(body)
	var absent []string
	for _, n := range need {
		if !strings.Contains(low, strings.ToLower(n)) {
			absent = append(absent, n)
		}
	}
	if len(absent) > 0 {
		more := ""
		if len(absent) > 12 {
			more = ", ..."
		}
		probs = append(probs, "it does not mention: "+strings.Join(absent[:min(12, len(absent))], ", ")+more)
	}
	if placeholderIn.MatchString(codeSpanRE.ReplaceAllString(body, "")) {
		probs = append(probs, "it still has placeholders (<...> or TODO)")
	}
	hash := sha(strings.TrimSpace(wsRE.ReplaceAllString(body, " ")) + "|" + strings.Join(capNames, ","))
	by := d.Str("approved_by")
	approved := by != "" && d.Str("approved_hash") == hash
	return understood{true, approved, by != "" && !approved, probs, hash, by}
}

type review struct {
	Data    FM
	Verdict string
	Score   float64
	Current bool
	Body    string
}

func (p *Project) reviewOf(kind string) *review {
	d, body, has := parseFM(readS(p.G("reviews", kind+".md")))
	if !has {
		return nil
	}
	cur := p.planHash()
	if kind == "spec" {
		cur = p.specHash()
	}
	sc, _ := strconv.ParseFloat(or(d.Str("score"), "0"), 64)
	return &review{d, d.Str("verdict"), sc, d.Str("hash") == cur, body}
}

func rvOK(r *review) bool {
	return r != nil && r.Current && (r.Verdict == "pass" || r.Verdict == "waived")
}

func (p *Project) signoffCurrent() (bool, bool) {
	d, _, has := parseFM(readS(p.G("signoff.md")))
	if !has {
		return false, false
	}
	return true, d.Str("spec_hash") == p.specHash()
}

var glossaryRE = regexp.MustCompile(`(?m)^[-*]\s+\*\*([^*]+)\*\*\s*[:\x{2013}\x{2014}-]\s*\S+`)

func (p *Project) glossaryTerms() int {
	return len(glossaryRE.FindAllString(readS(p.path("glossary.md")), -1))
}

// ---------- spec checks ----------

var (
	measureRE   = regexp.MustCompile(`(?i)\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*(?:ms|milliseconds?|s|sec|seconds?|min|minutes?|hours?|days?|months?|years?|percent|rps|req(?:uests?)?|users?|versions?|mb|gb|kb|tb|per\s+\w+|/\s?\w+)\b|\bnever\b`)
	reqHeadRE   = regexp.MustCompile(`(?m)^###.*$`)
	whenGivenRE = regexp.MustCompile(`(?m)^.*\*\*(?:WHEN|GIVEN)\*\*.*$`)
	contractRE  = regexp.MustCompile(`(?i)^contract\b`)
	failureRE   = regexp.MustCompile(`(?i)^failure\b`)
	whenRE      = regexp.MustCompile(`\bWHEN\b`)
	thenRE      = regexp.MustCompile(`\bTHEN\b`)
)

func contractProblems(cp string, reqs []*trace.Requirement) []string {
	var out []string
	if !slices.ContainsFunc(reqs, func(r *trace.Requirement) bool { return contractRE.MatchString(r.Name) }) {
		out = append(out, cp+`: no "### Requirement: Contract ..." (endpoints or messages, fields, authentication, rate limits)`)
	}
	n := 0
	for _, r := range reqs {
		for _, s := range r.Scenarios {
			if failureRE.MatchString(s.Name) {
				n++
			}
		}
	}
	if n < 2 {
		out = append(out, fmt.Sprintf(`%s: %d "#### Scenario: Failure: ..." scenario(s); an integration needs at least 2 (timeout or unavailable, rejected or malformed reply, duplicate or retry)`, cp, n))
	}
	return out
}

func nfrProblems(reqs []*trace.Requirement) []string {
	var out []string
	if len(reqs) == 0 {
		out = append(out, NFRCap+": no requirements")
	}
	for _, r := range reqs {
		b := whenGivenRE.ReplaceAllString(replaceFirst(reqHeadRE, r.Block, ""), "")
		if !measureRE.MatchString(b) {
			out = append(out, NFRCap+"/"+r.Slug+": no measurable target (a number with a unit: ms, %, users, MB, per second, ...)")
		}
	}
	return out
}

func replaceFirst(re *regexp.Regexp, s, repl string) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return s
	}
	return s[:loc[0]] + repl + s[loc[1]:]
}

func reqProblems(k string, r *trace.Requirement) []string {
	var out []string
	if len(r.Scenarios) == 0 {
		out = append(out, k+": no scenario")
	} else if !whenRE.MatchString(r.Block) || !thenRE.MatchString(r.Block) {
		out = append(out, k+": scenario without WHEN and THEN")
	}
	if r.WhyText() == "" {
		out = append(out, k+`: no "Why:" line (who wants it, and why)`)
	}
	return out
}

func (p *Project) living() *trace.Reqs { return trace.Living(p.Root.LivingSpecs()) }

func (p *Project) specProblems() []string {
	reqs := p.living()
	var out []string
	for _, k := range reqs.Keys() {
		r, _ := reqs.Get(k)
		out = append(out, reqProblems(k, r)...)
	}
	return out
}

// livingSpec is the parsed living spec of a capability, or nil.
func (p *Project) livingSpec(cp string) []*trace.Requirement {
	t, ok := read(filepath.Join(p.Root.LivingSpecs(), cp+".md"))
	if !ok {
		return nil
	}
	reqs := trace.ParseSpec(t).Reqs
	if reqs == nil {
		reqs = []*trace.Requirement{}
	}
	return reqs
}

func (p *Project) hasLiving(cp string) bool {
	return exists(filepath.Join(p.Root.LivingSpecs(), cp+".md"))
}

// ---------- changes that carry the spec (foundation, capabilities) ----------

type changeState struct {
	Exists, Complete  bool
	Missing, Problems []string
}

func (p *Project) activeExists(name string) bool { return isDir(p.Root.Change(name)) }

func (p *Project) changeState(name, cp string) changeState {
	dir := p.Root.Change(name)
	out := changeState{Exists: isDir(dir)}
	if !out.Exists {
		return out
	}
	for _, f := range []string{"proposal.md", "tasks.md"} {
		if !exists(filepath.Join(dir, f)) {
			out.Missing = append(out.Missing, f)
		}
	}
	if name == "foundation" {
		n := 0
		for _, f := range ls(filepath.Join(dir, "adrs"), ".md") {
			if !quality.IsNoneADR(f, readS(filepath.Join(dir, "adrs", f))) {
				n++
			}
		}
		if n == 0 {
			out.Missing = append(out.Missing, "adrs/ (at least one ADR: the fixed technology and architecture decisions)")
		}
	}
	deltas := trace.Deltas(dir)
	if len(deltas) == 0 {
		out.Missing = append(out.Missing, "specs/<capability>.md")
	}
	if exists(filepath.Join(dir, "proposal.md")) && !trace.IsSpecOnly(dir) {
		out.Problems = append(out.Problems, `proposal.md: add the line "Kind: spec-only" (this change only writes specs; nothing is implemented)`)
	}
	isInt := cp != "" && p.capByName(cp) != nil && p.capByName(cp).Kind == "integration"
	for _, d := range deltas {
		if cp != "" && d.Cap != cp && name != "foundation" {
			out.Problems = append(out.Problems, fmt.Sprintf("specs/%s: a capability change edits only its own capability (%s)", d.Cap, cp))
		}
		for _, r := range d.Reqs {
			if r.Op != "ADDED" && r.Op != "MODIFIED" {
				continue
			}
			out.Problems = append(out.Problems, reqProblems(d.Cap+"/"+r.Slug, r)...)
		}
		if d.Cap == NFRCap {
			out.Problems = append(out.Problems, nfrProblems(d.Reqs)...)
		}
		if cp != "" && d.Cap == cp && isInt {
			out.Problems = append(out.Problems, contractProblems(cp, d.Reqs)...)
		}
	}
	if name == "foundation" {
		if !slices.ContainsFunc(deltas, func(d trace.Delta) bool { return d.Cap == NFRCap }) {
			out.Missing = append(out.Missing, "specs/"+NFRCap+".md (measurable targets)")
		}
		if p.glossaryTerms() < 3 {
			out.Missing = append(out.Missing, p.Rel(p.path("glossary.md"))+` with at least 3 terms ("- **Term**: meaning")`)
		}
	}
	out.Complete = len(out.Missing) == 0 && len(out.Problems) == 0
	return out
}
