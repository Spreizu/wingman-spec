package greenfield

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Block is one thing a step waits for.
type Block struct {
	Kind string `json:"kind"`
	Who  string `json:"who,omitempty"`
	ID   string `json:"id,omitempty"`
	Text string `json:"text"`
}

// Next is the one next action.
type Next struct {
	Action   string   `json:"action"`
	Do       string   `json:"do"`
	Run      *string  `json:"run"`
	Agent    bool     `json:"agent"`
	Human    *string  `json:"human"`
	Problems []string `json:"problems"`
}

// PhaseState is done | current | todo.
type PhaseState struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

// Status is the derived state of the flow.
type Status struct {
	Mode        string         `json:"mode"`
	Marker      bool           `json:"marker"`
	Phases      []PhaseState   `json:"phases"`
	Ready       bool           `json:"ready"`
	Phase       *string        `json:"phase"`
	Step        string         `json:"step"`
	Next        *Next          `json:"next"`
	BlockedBy   []Block        `json:"blocked_by"`
	Done        []string       `json:"done"`
	Progress    string         `json:"progress,omitempty"`
	Counts      map[string]int `json:"counts,omitempty"`
	NextUp      []string       `json:"next_up,omitempty"`
	Manifest    string         `json:"manifest,omitempty"`
	ModeInfo    *Mode          `json:"mode_info,omitempty"`
	ModeSignals []Signal       `json:"mode_signals,omitempty"`
}

type step struct {
	Phase, Step, Do string
	Run, Human      string
	NoAgent         bool
	Problems        []string
	Blocked         []Block
}

func run(c string) string { return Run + " " + c }

func ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (p *Project) phaseInputs() *step {
	if len(p.inputFiles()) == 0 {
		in := p.Rel(p.path("inputs"))
		return &step{Phase: "Inputs", Step: "add-inputs", Do: "Put the client material (briefs, requirements, API docs, sample data, notes of calls) into " + in + "/. Read " + in + "/README.md first. Then run /spec-green-start again.",
			NoAgent: true, Human: "analyst", Blocked: []Block{{Kind: "inputs", Who: "analyst", Text: "client material in " + in + "/"}}}
	}
	return nil
}

func (p *Project) phaseQuestions() *step {
	const ph = "Questions"
	caps := p.capabilities()
	exp, hasExp := read(p.G("exploration.md"))
	if !hasExp {
		return &step{Phase: ph, Step: "explore", Do: fmt.Sprintf("Run the whole-product exploration: read %s/, interview the analyst with a grilling interview (one question at a time) until the users and what they need, capabilities, integrations and risks are clear. Create the exploration note with `%s` and fill it in. Write one file per capability or integration with `%s`.",
			p.Rel(p.path("inputs")), run("greenfield new exploration"), run("greenfield new capability <name> [--integration]")), Run: run("greenfield new exploration")}
	}
	lack := false
	for _, re := range explorationSections {
		if !hasH2(exp, re) {
			lack = true
		}
	}
	if lack || len(caps) == 0 {
		var probs []string
		if lack {
			probs = append(probs, p.Rel(p.G("exploration.md"))+" lacks sections: Capability map, Integration inventory")
		}
		if len(caps) == 0 {
			probs = append(probs, "no capability file in "+p.Rel(p.G("capabilities"))+"/")
		}
		return &step{Phase: ph, Step: "finish-exploration", Do: "Finish the exploration note and the capability files.", Problems: probs, Run: run("greenfield new capability <name> [--integration]")}
	}
	qs := p.questions()
	var missing []string
	for _, t := range Topics {
		if !slices.ContainsFunc(qs, func(q question) bool { return q.Topic == t.Name }) {
			missing = append(missing, "topic "+t.Name)
		}
	}
	if len(missing) > 0 {
		return &step{Phase: ph, Step: "create-questions", Do: "Create the fixed question files (one per topic). This writes only the files that do not exist yet.", Run: run("greenfield new questions"), Problems: missing}
	}
	var open, asked []question
	for _, q := range qs {
		if q.Status == "open" {
			open = append(open, q)
		}
		if q.Blocking && q.Status == "asked" {
			asked = append(asked, q)
		}
	}
	if len(open) > 0 {
		return &step{Phase: ph, Step: "answer-questions", Do: "Work through the open questions one by one. If " + p.Rel(p.path("inputs")) + "/ answers it: write the answer and cite the file (status: answered). If not: ask the client; set status: asked while you wait. If the client cannot answer yet and work can continue: status: assumed plus an assumption file. Not applicable: status: n/a with a reason.",
			Problems: joinIDs(open, func(q question) string { return fmt.Sprintf("%s (%s) is open", q.ID, q.Topic) }), Run: run("greenfield new assumption <slug> --from Q-<topic>")}
	}
	as := p.assumptions()
	var probs []string
	for _, q := range qs {
		if q.Status == "assumed" && !slices.ContainsFunc(as, func(a assumption) bool { return a.From == q.ID }) {
			probs = append(probs, q.ID+" is assumed but has no assumption file")
		}
	}
	for _, a := range as {
		if len(a.Bad) > 0 {
			probs = append(probs, a.ID+": fill in "+strings.Join(a.Bad, ", "))
		}
	}
	if len(probs) > 0 {
		return &step{Phase: ph, Step: "write-assumptions", Do: "Every assumed question needs an assumption with an owner, a verification point and a re-plan trigger.", Run: run("greenfield new assumption <slug> --from Q-<topic>"), Problems: probs}
	}
	if len(asked) > 0 {
		s := &step{Phase: ph, Step: "wait-for-client", Do: "Send the questions below to the client (a short list, one line each, with the owner). When the answers arrive, write them into the question files (status: answered) and run /spec-green-start again.", NoAgent: true, Human: "client"}
		for _, q := range asked {
			t := q.Answer
			if t == "" {
				t = topicText(q.Topic)
			}
			s.Problems = append(s.Problems, fmt.Sprintf("%s (%s): %s", q.ID, q.Topic, cut(t, 60)))
			s.Blocked = append(s.Blocked, Block{Kind: "client-answer", Who: q.Owner, ID: q.ID, Text: fmt.Sprintf("%s (%s)", q.ID, q.Topic)})
		}
		return s
	}
	if p.usableEnvs() == 0 {
		return &step{Phase: ph, Step: "write-environments", Do: fmt.Sprintf("Write down where it will run: `%s` (staging, production, ...), then fill in who provides access, which secrets are needed (names only, never values) and which roles or test accounts exist. Use what the client said under Q-environments.", run("greenfield new environment <name>")), Run: run("greenfield new environment <name>")}
	}
	us := p.understoodState()
	if !us.Exists || len(us.Problems) > 0 {
		s := &step{Phase: ph, Step: "write-understood", Do: fmt.Sprintf("Write the one-page summary the client will approve: `%s` creates the template. Plain words, at most 80 lines, no jargon; it must mention every capability, assumption and open question by id.", run("greenfield new understood")), Problems: us.Problems}
		if !us.Exists {
			s.Run = run("greenfield new understood")
		}
		return s
	}
	if !us.Approved {
		s := &step{Phase: ph, Step: "approve-understood", Do: fmt.Sprintf("Give %s to the client. When they agree, record it with `%s`. Changing the page or the capabilities afterwards makes the approval stale.", p.Rel(p.G("understood.md")), run(`greenfield approve understood --by "<client name>"`)),
			NoAgent: true, Human: "client", Run: run(`greenfield approve understood --by "<client name>"`), Blocked: []Block{{Kind: "approval", Who: "client", Text: `approval of "what we understood"`}}}
		if us.Stale {
			s.Problems = []string{"the approval is stale: the page changed after it"}
		}
		return s
	}
	return nil
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (p *Project) phaseFoundation() *step {
	const ph = "Foundation"
	if !p.activeExists("foundation") && p.hasLiving(NFRCap) && p.living().Len() > 0 && p.glossaryTerms() >= 3 && len(p.adrFiles()) > 0 {
		return nil
	}
	cs := p.changeState("foundation", "")
	arch := slices.ContainsFunc(p.archivedChanges(), func(n string) bool { return strings.HasSuffix(n, "-foundation") })
	if arch && !p.activeExists("foundation") {
		var probs []string
		if !p.hasLiving(NFRCap) {
			probs = append(probs, p.Rel(filepath.Join(p.Root.LivingSpecs(), NFRCap+".md"))+" missing")
		}
		if p.living().Len() == 0 {
			probs = append(probs, "no requirements")
		}
		if p.glossaryTerms() < 3 {
			probs = append(probs, "glossary has fewer than 3 terms")
		}
		if len(p.adrFiles()) == 0 {
			probs = append(probs, "no ADR")
		}
		return &step{Phase: ph, Step: "repair-foundation", Do: "The foundation was archived but is incomplete. Amend it with a new spec-only change (/spec-propose foundation-fix).", Problems: probs}
	}
	if cs.Exists && p.hasLiving(NFRCap) {
		return &step{Phase: ph, Step: "archive-foundation", Do: "The foundation is synced. Archive it: " + run("archive foundation") + ".", Run: run("archive foundation")}
	}
	if !cs.Exists {
		return &step{Phase: ph, Step: "propose-foundation", Do: fmt.Sprintf(`Create the spec-only change "foundation" (/spec-propose foundation, proposal line "Kind: spec-only"): the %s capability with measurable targets, the fixed ADRs (technology, hosting, auth, integration style), and %s. No code tasks: tasks.md is one ticked line.`, NFRCap, p.Rel(p.path("glossary.md"))), Run: run("new foundation")}
	}
	if !cs.Complete {
		return &step{Phase: ph, Step: "finish-foundation", Do: "Finish the foundation change.", Problems: append(joinIDs(cs.Missing, func(m string) string { return "missing " + m }), cs.Problems...)}
	}
	return &step{Phase: ph, Step: "sync-foundation", Do: "Sync and archive the foundation: /spec-sync foundation (" + run("sync foundation") + "), then " + run("archive foundation") + ".", Run: run("sync foundation")}
}

func (p *Project) capsDone(caps []capability) int {
	n := 0
	for _, c := range caps {
		if p.hasLiving(c.Cap) && !p.activeExists(c.Cap) {
			n++
		}
	}
	return n
}

func (p *Project) phaseCapabilities() *step {
	const ph = "Capabilities"
	caps := p.capabilities()
	var c *capability
	for i := range caps {
		if !p.hasLiving(caps[i].Cap) || p.activeExists(caps[i].Cap) {
			c = &caps[i]
			break
		}
	}
	if c == nil {
		return nil
	}
	where := fmt.Sprintf("capability %d of %d: %s", p.capsDone(caps)+1, len(caps), c.Cap)
	capFile := p.Rel(p.G("capabilities", c.Cap+".md"))
	tpl := ""
	if c.Kind == "integration" {
		tpl = fmt.Sprintf(` It is an integration: write the contract (the integration-contract template: %s), a sandbox in %s, and at least 2 "Failure:" scenarios.`, run("instructions specs"), capFile)
	}
	if p.activeExists(c.Cap) && p.hasLiving(c.Cap) {
		return &step{Phase: ph, Step: "archive-capability", Do: fmt.Sprintf("The %s spec is synced. Archive the change: %s.", c.Cap, run("archive "+c.Cap)), Run: run("archive " + c.Cap), Problems: []string{where}}
	}
	cs := p.changeState(c.Cap, c.Cap)
	if c.Kind == "integration" && isPlaceholder(c.Sandbox) {
		return &step{Phase: ph, Step: "describe-sandbox", Do: fmt.Sprintf("Integration %s needs a sandbox first: write it in %s (test endpoint, sample data, who provides access). If there is none yet, ask the client.", c.Cap, capFile), Problems: []string{where}}
	}
	if !cs.Exists {
		return &step{Phase: ph, Step: "propose-capability", Do: fmt.Sprintf(`Create the spec-only change "%s" (/spec-propose %s, proposal line "Kind: spec-only"): requirements with WHEN/THEN scenarios and a "Why:" line on each (who wants it, and why). No code tasks.%s`, c.Cap, c.Cap, tpl), Run: run("new " + c.Cap), Problems: []string{where}}
	}
	if !cs.Complete {
		return &step{Phase: ph, Step: "finish-capability", Do: "Finish the " + c.Cap + " change.", Problems: append(append([]string{where}, joinIDs(cs.Missing, func(m string) string { return "missing " + m })...), cs.Problems...)}
	}
	return &step{Phase: ph, Step: "sync-capability", Do: fmt.Sprintf("Sync the %s change: %s, then %s.", c.Cap, run("sync "+c.Cap), run("archive "+c.Cap)), Run: run("sync " + c.Cap), Problems: []string{where}}
}

var findingLineRE = regexp.MustCompile(`(?i)^-\s+(blocker|major)\b`)
var blockerLineRE = regexp.MustCompile(`(?i)^-\s+blocker\b`)
var blockerPrefixRE = regexp.MustCompile(`(?i)^-\s+blocker\s*\|?\s*`)

func grepLines(body string, re *regexp.Regexp, n int) []string {
	var out []string
	for l := range strings.SplitSeq(body, "\n") {
		if re.MatchString(l) && len(out) < n {
			out = append(out, l)
		}
	}
	return out
}

func (p *Project) phaseReview() *step {
	const ph = "Review"
	rv := p.reviewOf("spec")
	if rv == nil || !rv.Current {
		s := &step{Phase: ph, Step: "review-spec", Do: fmt.Sprintf("Get an independent review of the whole spec. Build the packet with `%s`, give it to the spec-reviewer subagent (a different agent from the one that wrote the specs), save its reply to a file and record it with `%s`. The writer never reviews its own spec.", run("greenfield review spec --packet"), run("greenfield review spec --reply <file>")), Run: run("greenfield review spec --packet")}
		if rv != nil {
			s.Problems = []string{"the specs changed after the last review"}
		}
		return s
	}
	if rv.Verdict == "fail" {
		return &step{Phase: ph, Step: "fix-review-findings", Do: "Fix the findings of the review with spec-only change(s) (/spec-propose <capability>), sync them, then review again. Findings are in " + p.Rel(p.G("reviews", "spec.md")) + ".", Problems: grepLines(rv.Body, findingLineRE, 12)}
	}
	has, cur := p.signoffCurrent()
	if !has || !cur {
		s := &step{Phase: ph, Step: "signoff-spec", Do: fmt.Sprintf("Give the reviewed spec to the client (%s, %s, %s). When they sign off: `%s`.", p.Rel(p.Root.LivingSpecs()), p.Rel(p.path("glossary.md")), p.Rel(p.Root.ADRs()), run(`greenfield approve spec --by "<client name>"`)),
			NoAgent: true, Human: "client", Run: run(`greenfield approve spec --by "<client name>"`), Blocked: []Block{{Kind: "approval", Who: "client", Text: "sign-off of the reviewed spec"}}}
		if has {
			s.Problems = []string{"the specs changed after the sign-off"}
		}
		return s
	}
	return nil
}

func (p *Project) phaseRoadmap() *step {
	const ph = "Roadmap"
	rm := p.Roadmap()
	if len(rm.Slices) == 0 {
		return &step{Phase: ph, Step: "plan", Do: "Run /spec-green-plan: split the finished spec into ordered slices (a thin end-to-end walking skeleton first, risky integrations early, one file per slice in " + p.Rel(p.path("roadmap")) + "/). Then run the roadmap check.", Run: run("roadmap")}
	}
	if !rm.OK {
		return &step{Phase: ph, Step: "fix-roadmap", Do: "Fix the roadmap errors (edit the slice files in " + p.Rel(p.path("roadmap")) + "/).", Problems: joinIDs(rm.Errors, func(e Issue) string { return e.Text }), Run: run("roadmap")}
	}
	pr, dr := p.reviewOf("plan"), p.reviewOf("dryrun")
	if pr == nil || !pr.Current {
		return &step{Phase: ph, Step: "review-plan", Do: fmt.Sprintf("Get an independent review of the plan: `%s`, spec-reviewer subagent, then `%s`.", run("greenfield review plan --packet"), run("greenfield review plan --reply <file>")), Run: run("greenfield review plan --packet")}
	}
	if pr.Verdict == "fail" {
		return &step{Phase: ph, Step: "fix-plan-findings", Do: "Fix the plan review findings (" + p.Rel(p.G("reviews", "plan.md")) + "), then review again.", Problems: grepLines(pr.Body, findingLineRE, 12)}
	}
	if dr == nil || !dr.Current {
		return &step{Phase: ph, Step: "dry-run", Do: fmt.Sprintf("Implementability dry-run: a reviewer who sees only the %s/ files lists what a developer could not decide for the first 2 slices. `%s`, spec-reviewer subagent, then `%s`.", p.Rel(p.S), run("greenfield review dryrun --packet"), run("greenfield review dryrun --reply <file>")), Run: run("greenfield review dryrun --packet")}
	}
	if dr.Verdict == "blocked" {
		u := grepLines(dr.Body, blockerLineRE, 12)
		return &step{Phase: ph, Step: "resolve-unknowns", Do: "The dry-run found blocking unknowns. Ask the client (or write an owned assumption), amend the specs or slices, then run the dry-run again.", Human: "client", Problems: u,
			Blocked: joinIDs2(u, func(x string) Block {
				return Block{Kind: "client-answer", Who: "client", Text: blockerPrefixRE.ReplaceAllString(x, "")}
			})}
	}
	return nil
}

func joinIDs2[T, U any](l []T, f func(T) U) []U {
	var out []U
	for _, x := range l {
		out = append(out, f(x))
	}
	return out
}

type handover struct {
	Rev     int  `json:"rev"`
	Current bool `json:"current"`
}

func (p *Project) handoverState() *handover {
	d, _, has := parseFM(readS(p.G("handover.md")))
	if !has {
		return nil
	}
	rev := 1
	_, _ = fmt.Sscanf(d.Str("rev"), "%d", &rev)
	return &handover{rev, d.Str("spec_hash") == p.specHash() && d.Str("plan_hash") == p.planHash()}
}

func (p *Project) phaseHandover() *step {
	g := p.Gate()
	if !g.Ready {
		f := g.Missing[0]
		var probs []string
		for _, m := range g.Missing {
			probs = append(probs, m.Text+":")
			for _, d := range m.Detail[:min(6, len(m.Detail))] {
				probs = append(probs, "  "+d)
			}
		}
		return &step{Phase: "Handover", Step: "fix-gate", Do: fmt.Sprintf("The handover gate has %d open item(s). First: %s", len(g.Missing), *f.Fix), Problems: probs}
	}
	h := p.handoverState()
	if h == nil || !h.Current {
		s := &step{Phase: "Handover", Step: "write-handover", Do: fmt.Sprintf("Everything is in place. Write the manifest: `%s`.", run("handover --write")), Run: run("handover --write")}
		if h != nil {
			s.Problems = []string{"the manifest is stale (specs or plan changed)"}
		}
		return s
	}
	return nil
}

// Derive is the state of the flow, from the files only.
func (p *Project) Derive() *Status {
	m := p.ModeOf()
	out := &Status{Mode: m.Mode, Marker: m.Marker, Phases: []PhaseState{}, BlockedBy: []Block{}, Done: []string{}}
	if m.Mode == Implementation {
		rm := p.Roadmap()
		ph := "Implementation"
		out.Phase, out.Step, out.Counts, out.NextUp = &ph, "build", rm.Counts, rm.NextUp
		out.Done = append(out.Done, fmt.Sprintf("handover accepted; slices: %d done, %d in progress, %d planned", rm.Counts["done"], rm.Counts["applying"]+rm.Counts["proposed"], rm.Counts["planned"]))
		n := &Next{Action: "finish", Do: "All slices are done. Check the remaining drift with /spec-garden.", Agent: true, Problems: []string{}}
		if len(rm.NextUp) > 0 {
			n.Action, n.Do = "next-slice", fmt.Sprintf("Run /spec-green-next (next slice: %s). Greenfield commands are read-only now; amend specs with /spec-propose.", rm.NextUp[0])
		}
		out.Next = n
		return out
	}
	if m.Mode == Brownfield || m.Mode == Greenfield || m.Mode == Unsupported {
		out.Step = "refused"
		if m.Mode == Greenfield {
			out.Step = "confirm-start"
		}
		out.ModeInfo = &m
		return out
	}
	evals := []func() *step{p.phaseInputs, p.phaseQuestions, p.phaseFoundation, p.phaseCapabilities, p.phaseReview, p.phaseRoadmap, p.phaseHandover}
	var cur *step
	for i, name := range Phases {
		if cur != nil {
			out.Phases = append(out.Phases, PhaseState{name, "todo"})
			continue
		}
		if s := evals[i](); s != nil {
			cur = s
			out.Phases = append(out.Phases, PhaseState{name, "current"})
		} else {
			out.Phases = append(out.Phases, PhaseState{name, "done"})
		}
	}
	if cur == nil {
		ph := "Handover"
		out.Ready, out.Phase, out.Step = true, &ph, "ready"
		h := p.handoverState()
		out.Next = &Next{Action: "send", Do: fmt.Sprintf("Send the repository (%s/, with the handover manifest) to the development team. They run /spec-green-next.", p.Rel(p.S)), Human: ptr("analyst"), Problems: []string{}}
		out.Done = []string{fmt.Sprintf("handover manifest rev %d", h.Rev)}
		out.Manifest = p.Rel(p.G("handover.md"))
		return out
	}
	ph := cur.Phase
	out.Phase, out.Step = &ph, cur.Step
	probs := cur.Problems
	if probs == nil {
		probs = []string{}
	}
	out.Next = &Next{Action: cur.Step, Do: cur.Do, Run: ptr(cur.Run), Agent: !cur.NoAgent, Human: ptr(cur.Human), Problems: probs}
	if cur.Blocked != nil {
		out.BlockedBy = cur.Blocked
	}
	caps := p.capabilities()
	for _, x := range out.Phases {
		if x.State == "done" {
			out.Done = append(out.Done, x.Name)
		}
	}
	if cur.Phase == "Capabilities" || out.Phases[3].State == "done" {
		out.Progress = fmt.Sprintf("capabilities %d of %d", p.capsDone(caps), len(caps))
	}
	qo := 0
	for _, q := range p.questions() {
		if q.Status == "open" || q.Status == "asked" {
			qo++
		}
	}
	out.Counts = map[string]int{"questions_open": qo, "capabilities": len(caps), "slices": len(p.readSlices())}
	return out
}

// Text is the status as text: the last three lines are Done / Next / Blocked by.
func (st *Status) Text() string {
	var L []string
	if st.Ready {
		L = append(L, "READY FOR HANDOVER")
	}
	if st.Phase != nil {
		l := "Phase: " + *st.Phase
		if len(st.Phases) > 0 {
			i := slices.IndexFunc(st.Phases, func(x PhaseState) bool { return x.State == "current" }) + 1
			if i == 0 {
				i = 7
			}
			l += fmt.Sprintf(" (%d of 7)", i)
		}
		l += "   Step: " + st.Step
		if st.Progress != "" {
			l += "   [" + st.Progress + "]"
		}
		L = append(L, l)
	}
	if len(st.Phases) > 0 {
		var parts []string
		for _, x := range st.Phases {
			b := "[ ]"
			switch x.State {
			case "done":
				b = "[x]"
			case "current":
				b = "[>]"
			}
			parts = append(parts, b+" "+x.Name)
		}
		L = append(L, "Phases: "+strings.Join(parts, "  "))
	}
	L = append(L, "")
	if st.Next != nil && len(st.Next.Problems) > 0 {
		L = append(L, "Details:")
		for _, x := range st.Next.Problems[:min(14, len(st.Next.Problems))] {
			L = append(L, "  - "+x)
		}
		if n := len(st.Next.Problems); n > 14 {
			L = append(L, fmt.Sprintf("  - ... %d more", n-14))
		}
		L = append(L, "")
	}
	done := "nothing yet"
	if len(st.Done) > 0 {
		done = strings.Join(st.Done, "; ")
	}
	L = append(L, "Done: "+done)
	nx := "-"
	if st.Next != nil {
		nx = st.Next.Do
		if st.Next.Run != nil {
			nx += "\n      run: " + *st.Next.Run
		}
		if st.Next.Human != nil {
			nx += "\n      needs a person: " + *st.Next.Human
		}
	}
	L = append(L, "Next: "+nx)
	bl := "nothing"
	if len(st.BlockedBy) > 0 {
		bl = strings.Join(joinIDs(st.BlockedBy, func(b Block) string {
			if b.Who != "" {
				return b.Text + " (" + b.Who + ")"
			}
			return b.Text
		}), "; ")
	}
	L = append(L, "Blocked by: "+bl)
	return strings.Join(L, "\n")
}
