package greenfield

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// InputsReadme is the inputs/README.md the start writes.
const InputsReadme = "# Inputs\n\nPut everything the client gave you in this folder: briefs, requirements, screenshots, API documents, e-mail threads, spreadsheets, sample data, design links.\n\n- One file per source; keep the original name. For calls and chats write a short note: date, who, what was said.\n- Never put passwords, tokens or keys here. Write the secret's name (for example PAYMENTS_API_KEY) and who provides it.\n- Messy is fine: the agent reads all of it and asks you for what is missing.\n\nThen run /spec-green-start in your agent. Run it again whenever it asks you to: it always continues where the project is.\n"

func (p *Project) tplExploration() string {
	return "# Exploration: <product name>\n\n## Capability map\n<one line per capability or integration, with its priority; the machine-readable files are " + p.Rel(p.G("capabilities")) + "/>\n\n## Integration inventory\n<one line per external system: purpose, direction, owner, sandbox>\n"
}

func tplQuestion(topic, text string) string {
	if text == "" {
		text = or(topicText(topic), "<the question, in one or two sentences>")
	}
	return "---\nid: Q-" + topic + "\ntopic: " + topic + "\nstatus: open        # open | asked | answered | assumed | n/a\nblocking: yes\nowner: client\n---\n## Question\n" + text +
		"\n\n## Answer\n<!-- Fill in and cite the source (inputs/<file>, or who answered and when). status: asked = sent to the client, waiting. status: assumed needs an A-<slug> assumption. status: n/a needs a reason here. -->\n"
}

func tplAssumption(slug, from string) string {
	return "---\nid: A-" + slug + "\nfrom: " + or(from, "Q-<topic>") + "\nowner: <who verifies it>\nstatus: open        # open | verified | invalidated\nverify_by: <the moment or milestone by which it must be verified>\nreplan_trigger: <what happens to the plan if it turns out false>\n---\n## Assumption\n<one sentence>\n"
}

func tplCapability(name, kind string) string {
	sb := "n/a"
	if kind == "integration" {
		sb = "          # test endpoint, sample data and who provides access"
	}
	return "---\ncapability: " + name + "\nkind: " + kind + "        # capability | integration\npriority: P0         # P0 = the first slice needs it, P1, P2 ...\nrisk: none           # none, or any of: security, money, data-migration, concurrency, public-api\nsandbox: " + sb + "\n---\n<one line: what a user or a system can do with it>\n"
}

func tplEnvironment(name string) string {
	return "---\nname: " + name + "\naccess: <who provides access, and which secrets are needed (names only, never values)>\nroles: [<role or test account>]\n---\n<what runs here and who may use it>\n"
}

func tplSlice(id string) string {
	return "---\nid: " + id + "\ntitle: <what a user or system can do after this slice>\ncapabilities: [<capability>, <capability>/<requirement-slug>]\ndepends_on: []\nsize: S\nstatus: planned\nmilestone: m1\nskeleton: false\ncontract_tests: []\n---\n## Acceptance criteria\n- <observable result that shows the slice is done>\n\n## Notes\n<anything the developer needs and the specs do not say; design links, sample data files>\n"
}

const tplUnderstood = "---\napproved_by:\napproved_on:\napproved_hash:\n---\n# What we understood\n\n## Product in one paragraph\n<...>\n\n## Users and what they need\n<one line per role>\n\n## What it must do\n<one line per capability, with its priority>\n\n## Systems it connects to\n<one line per integration: what flows, who owns it>\n\n## What happens when things fail\n<one line per integration or risky flow>\n\n## Targets\n<the numbers: speed, users, availability, retention>\n\n## Out of scope\n<...>\n\n## Assumptions we made\n<one line per A-id: what, who verifies, by when>\n\n## Still open\n<one line per open question that is not blocking: Q-id, owner>\n"

// ---------- review packets and replies ----------

var rubric = map[string][]string{
	"spec":   {"Every requirement has a Why that names who wants it and why, and WHEN/THEN scenarios a tester can run.", `No vague words in requirements or scenarios ("fast", "user-friendly", "appropriate", "etc."): each has a number or an observable result.`, "Every integration has a contract (fields, auth, limits) and failure scenarios (timeout, rejection, duplicate); sandbox data is named.", "NFRs are measurable; terms match the glossary; no two capabilities contradict each other.", "Nothing is left for the developer to guess: no missing roles, states, error texts, limits, or data rules. No implementation instructions in the specs.", "Every decision the client has not made is an owned assumption, not a silent default.", "Every UI-facing requirement (screen, form, control, visual scenario) has its proposal's UX checklist answered: loading, empty, error, disabled, validation, recovery, keyboard, narrow and long-text each name an existing scenario or give a `Not applicable:` reason specific to that screen."},
	"plan":   {"The first slice is a thin end-to-end walking skeleton that proves the architecture and the riskiest integration path.", "Risky integrations and unknowns come early; nothing risky is left for the last slices.", "Each slice is small enough for one agent session (S/M), independently demonstrable, with acceptance criteria that name an observable result.", "Dependencies are real (not just a list order); slices that can run in parallel are not chained.", "Every requirement is covered exactly once; later slices do not secretly redo earlier ones.", "Assumptions with a re-plan trigger map to the slices they would affect."},
	"dryrun": {"Pretend you are a developer who has only the spec files and the first two slices in order (the walking skeleton and the next).", "List everything you could not decide or build without asking: missing data, unclear rules, undefined errors, unknown credentials or accounts, ambiguous terms.", "Mark UNKNOWN: blocker when you could not start or finish the slice; minor when you could proceed with a reasonable default (say which)."},
}

// Packet is the read-only review packet for the spec-reviewer subagent.
func (p *Project) Packet(kind string) string {
	g := p.Gate()
	rm := g.Roadmap
	title := map[string]string{"spec": "Independent spec review", "plan": "Independent plan review", "dryrun": "Implementability dry-run"}[kind]
	L := []string{"# " + title, "", "You are the spec-reviewer subagent. You did not write these files. Read only; change nothing. Judge only what is written; do not assume the intent of the author.", "", "## Read these",
		"- " + p.Rel(p.G("understood.md")) + " (what the client approved)", "- " + p.Rel(p.Root.LivingSpecs()) + "/*.md", "- " + p.Rel(p.path("glossary.md")) + " and " + p.Rel(p.Root.ADRs()) + "/*.md"}
	if kind != "spec" {
		L = append(L, "- "+p.Rel(p.path("roadmap"))+"/*.md (the slices)")
	}
	L = append(L, "- "+p.Rel(p.G("capabilities"))+"/*.md, records/*.md (questions Q-, assumptions A-, environments ENV-)", "", "## The project",
		"Capabilities: "+strings.Join(joinIDs(p.capabilities(), func(c capability) string { return fmt.Sprintf("%s (%s, %s)", c.Cap, c.Kind, c.Priority) }), "; "))
	if kind != "spec" {
		L = append(L, "Slices in order: "+or(strings.Join(rm.Order, " -> "), "none"))
	}
	if kind == "dryrun" {
		L = append(L, "The first two slices: "+strings.Join(rm.Order[:min(2, len(rm.Order))], ", "))
	}
	L = append(L, "", "## Check")
	for _, r := range rubric[kind] {
		L = append(L, "- "+r)
	}
	L = append(L, "", "## Deterministic checks already run (do not repeat them; look for what they cannot see)")
	n := len(g.Items)
	if kind == "spec" {
		n = min(12, n)
	}
	for _, it := range g.Items[:n] {
		st := "open"
		if it.OK {
			st = "ok"
		}
		L = append(L, "- ["+st+"] "+it.Text)
	}
	L = append(L, "", "## Reply in exactly this format, nothing else", "```")
	if kind == "dryrun" {
		L = append(L, "VERDICT: pass|blocked", "UNKNOWN: blocker|minor | <slice id> | <what you could not decide or build> | <what is needed, from whom>")
	} else {
		L = append(L, "VERDICT: pass|fail", "SCORE: <0-100; 80 or more only if you would hand this to a developer team>", "FINDING: blocker|major|minor | <file or capability/requirement> | <what is wrong and what it should say>")
	}
	L = append(L, "```", "One line per finding. Quote the file. Fewer than 3 findings means you did not look hard enough: look again for vague words, missing failure cases, undefined roles.")
	return strings.Join(L, "\n") + "\n"
}

type finding struct{ Sev, Where, What string }

type reply struct {
	Verdict          string
	Score            *int
	Blockers, Majors int
	Items            []finding
	Reason, Reviewer string
}

var (
	verdictRE = regexp.MustCompile(`(?i)^VERDICT:\s*(pass|fail|blocked)\b`)
	scoreRE   = regexp.MustCompile(`(?i)^SCORE:\s*(\d{1,3})\b`)
	itemRE    = map[string]*regexp.Regexp{
		"FINDING": regexp.MustCompile(`(?i)^FINDING:\s*(blocker|major|minor)\s*\|\s*(.*?)\s*\|\s*(.+)$`),
		"UNKNOWN": regexp.MustCompile(`(?i)^UNKNOWN:\s*(blocker|major|minor)\s*\|\s*(.*?)\s*\|\s*(.+)$`),
	}
)

func parseReply(text, kind string) (*reply, string) {
	var lines []string
	for l := range strings.SplitSeq(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		lines = append(lines, strings.TrimSpace(l))
	}
	var v, sc []string
	for _, l := range lines {
		if v == nil {
			v = verdictRE.FindStringSubmatch(l)
		}
		if sc == nil {
			sc = scoreRE.FindStringSubmatch(l)
		}
	}
	if v == nil {
		return nil, `the reply has no "VERDICT: pass|fail" line (dry-run: pass|blocked)`
	}
	if kind != "dryrun" && sc == nil {
		return nil, `the reply has no "SCORE: <0-100>" line`
	}
	tag := "FINDING"
	if kind == "dryrun" {
		tag = "UNKNOWN"
	}
	r := &reply{}
	for _, l := range lines {
		if m := itemRE[tag].FindStringSubmatch(l); m != nil {
			f := finding{strings.ToLower(m[1]), m[2], m[3]}
			r.Items = append(r.Items, f)
			switch f.Sev {
			case "blocker":
				r.Blockers++
			case "major":
				r.Majors++
			}
		}
	}
	if sc != nil {
		n, _ := strconv.Atoi(sc[1])
		r.Score = &n
	}
	verdict := strings.ToLower(v[1])
	if kind == "dryrun" {
		r.Verdict = "blocked"
		if verdict == "pass" && r.Blockers == 0 {
			r.Verdict = "pass"
		}
	} else {
		r.Verdict = "fail"
		if verdict == "pass" && r.Blockers == 0 && r.Score != nil && *r.Score >= 80 {
			r.Verdict = "pass"
		}
	}
	return r, ""
}

func (p *Project) writeReview(kind string, r *reply) (int, error) {
	dir := p.G("reviews")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, err
	}
	old, _, _ := parseFM(readS(filepath.Join(dir, kind+".md")))
	rounds, _ := strconv.Atoi(or(old.Str("rounds"), "0"))
	rounds++
	hash := p.planHash()
	if kind == "spec" {
		hash = p.specHash()
	}
	head := []string{"---", "kind: " + kind, "verdict: " + r.Verdict}
	if r.Score != nil {
		head = append(head, fmt.Sprintf("score: %d", *r.Score))
	}
	head = append(head, fmt.Sprintf("blockers: %d", r.Blockers), fmt.Sprintf("majors: %d", r.Majors), "reviewer: "+r.Reviewer)
	if r.Reason != "" {
		head = append(head, "reason: "+strings.ReplaceAll(r.Reason, "\n", " "))
	}
	head = append(head, fmt.Sprintf("rounds: %d", rounds), "hash: "+hash, "date: "+p.today(), "---", "")
	body := "No findings.\n"
	switch {
	case len(r.Items) > 0:
		body = strings.Join(joinIDs(r.Items, func(f finding) string { return "- " + f.Sev + " | " + f.Where + " | " + f.What }), "\n") + "\n"
	case r.Reason != "":
		body = "Waived: " + r.Reason + "\n"
	}
	return rounds, os.WriteFile(filepath.Join(dir, kind+".md"), []byte(strings.Join(head, "\n")+body), 0o644)
}

// ---------- the manifest ----------

var questionTextRE = regexp.MustCompile(`## Question\n((?s:.*?))\n\n`)

func (p *Project) writeHandover(g *Gate) (int, error) {
	rm := g.Roadmap
	old, _, _ := parseFM(readS(p.G("handover.md")))
	rev, _ := strconv.Atoi(or(old.Str("rev"), "0"))
	rev++
	caps := p.capabilities()
	ints := 0
	for _, c := range caps {
		if c.Kind == "integration" {
			ints++
		}
	}
	rv, pr, dr := p.reviewOf("spec"), p.reviewOf("plan"), p.reviewOf("dryrun")
	ud, _, _ := parseFM(readS(p.G("understood.md")))
	so, _, _ := parseFM(readS(p.G("signoff.md")))
	scoreOf := func(r *review) string {
		if r.Score != 0 {
			return ", score " + fmtScore(r.Score)
		}
		return ""
	}
	dash := func(s string) string { return or(s, "-") }
	L := []string{"---", fmt.Sprintf("rev: %d", rev), "date: " + p.today(), "spec_hash: " + p.specHash(), "plan_hash: " + p.planHash(), "---", "# Handover", "",
		"Everything the development team needs is in this repository. Start with /spec-green-next.", "",
		"## What is delivered",
		fmt.Sprintf("- Capabilities: %d (%d integrations); requirements: %d; slices: %d; ADRs: %d; glossary terms: %d", len(caps), ints, p.living().Len(), len(rm.Order), len(p.adrFiles()), p.glossaryTerms()),
		fmt.Sprintf("- %s/ (the end-state spec), %s/, %s, %s/ (ordered slices), %s/ (records: questions, assumptions, environments; reviews)",
			p.Rel(p.Root.LivingSpecs()), p.Rel(p.Root.ADRs()), p.Rel(p.path("glossary.md")), p.Rel(p.path("roadmap")), p.Rel(p.G())), "",
		"## Records", "- Client approval of the summary: " + dash(ud.Str("approved_by")) + ", " + dash(ud.Str("approved_on"))}
	if rv != nil {
		L = append(L, fmt.Sprintf("- Spec review: %s%s, %s round(s), %s", rv.Verdict, scoreOf(rv), or(rv.Data.Str("rounds"), "1"), rv.Data.Str("date")))
	} else {
		L = append(L, "- Spec review: -")
	}
	L = append(L, "- Spec sign-off: "+dash(so.Str("approved_by"))+", "+dash(so.Str("approved_on")))
	if pr != nil {
		L = append(L, fmt.Sprintf("- Plan review: %s%s, %s", pr.Verdict, scoreOf(pr), pr.Data.Str("date")))
	} else {
		L = append(L, "- Plan review: -")
	}
	if dr != nil {
		L = append(L, fmt.Sprintf("- Implementability dry-run: %s, %s", dr.Verdict, dr.Data.Str("date")))
	} else {
		L = append(L, "- Implementability dry-run: -")
	}
	for _, w := range g.Warnings {
		L = append(L, "- Note: "+w)
	}
	L = append(L, "", "## Roadmap", "| # | slice | size | milestone | depends on | requirements |", "|---|---|---|---|---|---|")
	for i, s := range rm.Slices {
		sk := ""
		if s.Skeleton {
			sk = " (skeleton)"
		}
		L = append(L, fmt.Sprintf("| %d | %s%s | %s | %s | %s | %d |", i+1, s.ID, sk, s.Size, s.Milestone, or(strings.Join(s.DependsOn, ", "), "-"), s.Requirements))
	}
	L = append(L, "", "## Traceability (slice -> requirement -> code)", "Code is linked to requirements by the anchors the dev team writes; `wingman-spec drift` shows what is not built yet.", "| slice | requirement | why |", "|---|---|---|")
	for _, s := range rm.Slices {
		items := rm.Trace[s.ID]
		if len(items) == 0 {
			items = []TraceItem{{"-", ""}}
		}
		for _, r := range items {
			L = append(L, fmt.Sprintf("| %s | %s | %s |", s.ID, r.Key, or(r.Why, "-")))
		}
	}
	L = append(L, "", "## Open assumptions")
	n := 0
	for _, a := range p.assumptions() {
		if a.Status == "open" {
			L = append(L, fmt.Sprintf("- %s: owner %s; verify %s; if false: %s", a.ID, a.Owner, a.VerifyBy, a.Replan))
			n++
		}
	}
	if n == 0 {
		L = append(L, "- none")
	}
	L = append(L, "", "## Open questions (not blocking)")
	n = 0
	for _, q := range p.questions() {
		if !q.Blocking && (q.Status == "open" || q.Status == "asked") {
			t := ""
			if m := questionTextRE.FindStringSubmatch(q.Body); m != nil {
				t = cut(wsRE.ReplaceAllString(m[1], " "), 160)
			}
			L = append(L, fmt.Sprintf("- %s: owner %s; %s", q.ID, q.Owner, t))
			n++
		}
	}
	if n == 0 {
		L = append(L, "- none")
	}
	L = append(L, "", "## Change control", "- Later changes go through /spec-propose (amend); a change that rewrites the Why of a requirement or removes a requirement needs the owner's approval.",
		"- If an assumption turns out false, follow its re-plan trigger, then re-run `wingman-spec handover --write`.", "")
	return rev, os.WriteFile(p.G("handover.md"), []byte(strings.Join(L, "\n")), 0o644)
}
