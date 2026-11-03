package greenfield

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Env is where a command reads and writes.
type Env struct {
	Out, Err io.Writer
	In       io.Reader
	Cwd      string
}

type opts struct {
	args  []string
	val   map[string]string
	flags map[string]bool
}

var valued = []string{"by", "reply", "reviewer", "reason", "out", "from", "for", "text"}

type cmdErr struct{ code int }

func (c cmdErr) Error() string { return "greenfield" }

func (e *Env) out(s string) { fmt.Fprintln(e.Out, s) }

func (e *Env) json(v any) {
	enc := json.NewEncoder(e.Out)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

const usageLine = "usage: wingman-spec mode [--for CMD] | greenfield status|start|new|approve|review|readme ... | roadmap [--next] | handover [--write]  (add --json for machine output)"

func (e *Env) usage(msg string) error {
	fmt.Fprintf(e.Err, "%s\n%s\n", msg, usageLine)
	return cmdErr{2}
}

func (e *Env) parse(args []string) (opts, error) {
	o := opts{val: map[string]string{}, flags: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if k, ok := strings.CutPrefix(a, "--"); ok {
			if name, v, has := strings.Cut(k, "="); has && slices.Contains(valued, name) {
				o.val[name] = v
				continue
			}
			if slices.Contains(valued, k) {
				if i+1 >= len(args) {
					return opts{}, e.usage(a + " needs a value")
				}
				o.val[k] = args[i+1]
				i++
				continue
			}
			o.flags[k] = true
			continue
		}
		o.args = append(o.args, a)
	}
	return o, nil
}

// Main runs one of mode | greenfield | roadmap | handover with its raw arguments and returns the exit code.
func Main(p *Project, e *Env, cmd string, args []string) int {
	err := e.dispatch(p, cmd, args)
	if err == nil {
		return 0
	}
	if x, ok := errors.AsType[cmdErr](err); ok {
		return x.code
	}
	fmt.Fprintln(e.Err, err)
	return 1
}

func (e *Env) dispatch(p *Project, cmd string, args []string) error {
	o, err := e.parse(args)
	if err != nil {
		return err
	}
	switch cmd {
	case "mode":
		return e.cmdMode(p, o)
	case "roadmap":
		return e.cmdRoadmap(p, o)
	case "handover":
		return e.cmdHandover(p, o)
	case "greenfield":
		if len(o.args) == 0 {
			return e.usage("greenfield <status|start|new|approve|review|readme>")
		}
		sub := o.args[0]
		o.args = o.args[1:]
		f := map[string]func(*Project, opts) error{"status": e.cmdStatus, "start": e.cmdStart, "new": e.cmdNew, "approve": e.cmdApprove, "review": e.cmdReview, "readme": e.cmdReadme}[sub]
		if f == nil {
			return e.usage("greenfield <status|start|new|approve|review|readme>")
		}
		return f(p, o)
	default:
		return e.usage("unknown greenfield command '" + cmd + "'")
	}
}

var cmdName = map[string]string{"start": "/spec-green-start", "status": "/spec-green-start", "plan": "/spec-green-plan", "next": "/spec-green-next", "adopt": "/spec-adopt"}

func (e *Env) refuse(m Mode, cmd string, js bool) error {
	r := Refuse(m, cmd)
	if js {
		e.json(r)
	} else {
		e.out(fmt.Sprintf("REFUSED: %s (project mode: %s). Nothing was written.", or(cmdName[cmd], cmd), m.Mode))
		for _, w := range r.Why {
			e.out("  " + w)
		}
		if m.Mode == Greenfield {
			e.out("  This repository has not been started as a new product yet. Run /spec-green-start: it asks you to confirm once (a new product has no code yet).")
		} else {
			e.out("  " + r.Alternative)
		}
	}
	return cmdErr{ExitRefused}
}

func (e *Env) guard(p *Project, cmd string, o opts) (Mode, error) {
	m := p.ModeFor(cmd)
	if !Allowed(m.Mode, cmd) {
		return m, e.refuse(m, cmd, o.flags["json"])
	}
	return m, nil
}

// guardKind: read works in progress and in implementation; write only in progress.
func (e *Env) guardKind(p *Project, kind string, o opts) error {
	m := p.ModeFor("next")
	ok := m.Mode == InProgress || (kind == "read" && m.Mode == Implementation)
	if !ok {
		c := "next"
		if kind == "write" {
			c = "plan"
		}
		return e.refuse(m, c, o.flags["json"])
	}
	return nil
}

func (e *Env) cmdMode(p *Project, o opts) error {
	m := p.ModeFor(strings.TrimPrefix(strings.TrimPrefix(o.val["for"], "/"), "spec-"))
	if o.val["for"] == "" {
		m = p.ModeOf()
	}
	if m.Mode == Unsupported {
		if o.flags["json"] {
			e.json(map[string]any{"mode": Unsupported, "refused": true, "alternative": Alternative[Unsupported], "wrote": "nothing"})
		} else {
			e.out("mode: unsupported layout\n" + Alternative[Unsupported])
		}
		if o.val["for"] != "" {
			return cmdErr{ExitRefused}
		}
		return nil
	}
	f := o.val["for"]
	if f != "" {
		c := strings.TrimPrefix(strings.TrimPrefix(f, "/"), "spec-")
		if For[c] == nil {
			var ks []string
			for k := range For {
				ks = append(ks, k)
			}
			slices.Sort(ks)
			return e.usage(fmt.Sprintf("unknown command '%s' (one of %s)", f, strings.Join(ks, ", ")))
		}
		if !Allowed(m.Mode, c) {
			return e.refuse(m, c, o.flags["json"])
		}
	}
	if o.flags["json"] {
		type withAllowed struct {
			Mode
			Allowed bool `json:"allowed,omitempty"`
		}
		e.json(withAllowed{m, f != ""})
		return nil
	}
	l := "mode: " + m.Mode
	if m.MarkerMissing {
		l += " (" + p.Rel(p.Marker()) + " is missing; /spec-green-start will restore it)"
	}
	e.out(l)
	for _, s := range m.Signals {
		e.out("  " + s.Kind + ": " + s.Detail)
	}
	if len(m.CodeRepos) > 0 {
		e.out("  code repos: " + strings.Join(m.CodeRepos, ", "))
	}
	if f != "" {
		e.out("allowed: /" + strings.TrimPrefix(f, "/"))
	}
	return nil
}

func (e *Env) write(f, text string) error {
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		fmt.Fprintln(e.Err, err)
		return cmdErr{1}
	}
	if err := os.WriteFile(f, []byte(text), 0o644); err != nil {
		fmt.Fprintln(e.Err, err)
		return cmdErr{1}
	}
	return nil
}

func (e *Env) cmdStart(p *Project, o opts) error {
	m, err := e.guard(p, "start", o)
	if err != nil {
		return err
	}
	if m.Marker {
		e.out(fmt.Sprintf("already started (%s); nothing changed. Run: %s", m.Mode, run("greenfield status")))
		return nil
	}
	marker, readme := p.Rel(p.Marker()), p.Rel(p.path("inputs", "README.md"))
	if !o.flags["yes"] {
		e.out(fmt.Sprintf("dry run. This would mark %s as a NEW product (no existing code, specs written from requirements): it writes %s and %s and nothing else.\nConfirm with the analyst that this is a new product, then re-run with: greenfield start --by \"<analyst name>\" --yes", p.Root.Code, marker, readme))
		return nil
	}
	by := strings.TrimSpace(o.val["by"])
	if len(by) < 2 {
		return e.usage(`start needs --by "<analyst name>"`)
	}
	_ = os.MkdirAll(p.G(), 0o755)
	if err := e.write(p.Marker(), "# Marks this repository as a new product (greenfield). Written once, after the analyst confirmed it. Do not delete.\nschema: wingman-spec\nmode: greenfield\nstarted: "+p.today()+"\nconfirmed_by: "+by+"\n"); err != nil {
		return err
	}
	if !exists(p.path("inputs", "README.md")) {
		if err := e.write(p.path("inputs", "README.md"), InputsReadme); err != nil {
			return err
		}
	}
	e.out(fmt.Sprintf("started: wrote %s and %s. Next: put the client material into %s/, then run /spec-green-start.", marker, readme, p.Rel(p.path("inputs"))))
	return nil
}

func (e *Env) cmdReadme(p *Project, _ opts) error {
	m := p.ModeFor("start")
	if m.Mode != Greenfield && m.Mode != InProgress {
		e.out("not a greenfield project (" + m.Mode + "); nothing written")
		return nil
	}
	f := p.path("inputs", "README.md")
	if exists(f) {
		e.out(p.Rel(f) + " exists; unchanged")
		return nil
	}
	if err := e.write(f, InputsReadme); err != nil {
		return err
	}
	e.out("wrote " + p.Rel(f))
	return nil
}

func (e *Env) cmdStatus(p *Project, o opts) error {
	m, err := e.guard(p, "status", o)
	if err != nil {
		return err
	}
	st := p.Derive()
	st.ModeSignals = m.Signals
	if o.flags["json"] {
		e.json(st)
		return nil
	}
	if st.Step == "confirm-start" {
		e.out("Phase: not started   Step: confirm-start\n")
		e.out("Done: nothing yet\nNext: Ask the analyst: \"Is this a NEW product with no existing code, and are we writing its specification from requirements?\" If yes, run:\n      run: " + run(`greenfield start --by "<analyst name>" --yes`) + "\n      needs a person: analyst\nBlocked by: the analyst's confirmation")
		return nil
	}
	e.out(st.Text())
	return nil
}

func (e *Env) slugOK(n, what string) error {
	if !kebabRE.MatchString(n) {
		return e.usage(fmt.Sprintf("%s must be kebab-case (a-z, 0-9, -): got '%s'", what, n))
	}
	return nil
}

func (e *Env) writeNew(p *Project, f, text string) error {
	if exists(f) {
		e.out("exists, not overwritten: " + p.Rel(f))
		return nil
	}
	if err := e.write(f, text); err != nil {
		return err
	}
	e.out("created " + p.Rel(f))
	return nil
}

func (e *Env) cmdNew(p *Project, o opts) error {
	if err := e.guardKind(p, "write", o); err != nil {
		return err
	}
	kind, name := "", ""
	if len(o.args) > 0 {
		kind = o.args[0]
	}
	if len(o.args) > 1 {
		name = o.args[1]
	}
	rec := func(f string) string { return p.G(records, f) }
	switch kind {
	case "exploration":
		if err := e.writeNew(p, p.G("exploration.md"), p.tplExploration()); err != nil {
			return err
		}
	case "understood":
		if err := e.writeNew(p, p.G("understood.md"), tplUnderstood); err != nil {
			return err
		}
	case "questions":
		for _, t := range Topics {
			if err := e.writeNew(p, rec("Q-"+t.Name+".md"), tplQuestion(t.Name, "")); err != nil {
				return err
			}
		}
	case "question":
		if err := e.slugOK(name, "question topic"); err != nil {
			return err
		}
		if err := e.writeNew(p, rec("Q-"+name+".md"), tplQuestion(name, o.val["text"])); err != nil {
			return err
		}
	case "assumption":
		if err := e.slugOK(name, "assumption slug"); err != nil {
			return err
		}
		if err := e.writeNew(p, rec("A-"+name+".md"), tplAssumption(name, o.val["from"])); err != nil {
			return err
		}
	case "capability":
		if err := e.slugOK(name, "capability name"); err != nil {
			return err
		}
		k := "capability"
		if o.flags["integration"] {
			k = "integration"
		}
		if err := e.writeNew(p, p.G("capabilities", name+".md"), tplCapability(name, k)); err != nil {
			return err
		}
	case "environment":
		if err := e.slugOK(name, "environment name"); err != nil {
			return err
		}
		if err := e.writeNew(p, rec("ENV-"+name+".md"), tplEnvironment(name)); err != nil {
			return err
		}
	case "slice":
		if err := e.slugOK(name, "slice id"); err != nil {
			return err
		}
		if err := e.writeNew(p, p.path("roadmap", name+".md"), tplSlice(name)); err != nil {
			return err
		}
	default:
		return e.usage(`new <exploration|understood|questions|question <topic> [--text "..."]|assumption <slug> [--from Q-x]|capability <name> [--integration]|environment <name>|slice <id>>`)
	}
	return nil
}

var specGateItems = []string{"understood", "questions", "requirements", "capabilities", "integrations", "nfr", "glossary", "adrs", "no-secrets", "assumptions"}

func (e *Env) cmdApprove(p *Project, o opts) error {
	if err := e.guardKind(p, "write", o); err != nil {
		return err
	}
	what := ""
	if len(o.args) > 0 {
		what = o.args[0]
	}
	by := strings.TrimSpace(o.val["by"])
	if len(by) < 2 {
		return e.usage(`approve needs --by "<name of the person who approved>"`)
	}
	switch what {
	case "understood":
		us := p.understoodState()
		if !us.Exists || len(us.Problems) > 0 {
			e.out("not approved: fix the page first")
			for _, x := range us.Problems {
				e.out("  - " + x)
			}
			return cmdErr{1}
		}
		var open []string
		for _, q := range p.questions() {
			if q.Blocking && (q.Status == "open" || q.Status == "asked") {
				open = append(open, q.ID)
			}
		}
		if len(open) > 0 {
			e.out("not approved: blocking question(s) still open: " + strings.Join(open, ", "))
			return cmdErr{1}
		}
		f := p.G("understood.md")
		if err := e.write(f, SetFM(readS(f), []string{"approved_by", "approved_on", "approved_hash"}, map[string]string{"approved_by": by, "approved_on": p.today(), "approved_hash": us.Hash})); err != nil {
			return err
		}
		e.out(`recorded: "what we understood" approved by ` + by)
	case "spec":
		rv := p.reviewOf("spec")
		if !rvOK(rv) {
			e.out("not signed off: the spec needs a current passing review first (run /spec-green-start)")
			return cmdErr{1}
		}
		g := p.Gate()
		var blocking []Item
		for _, it := range g.Missing {
			if slices.Contains(specGateItems, it.ID) {
				blocking = append(blocking, it)
			}
		}
		if len(blocking) > 0 {
			e.out("not signed off: the spec has open gate items")
			for _, b := range blocking {
				d := ""
				if len(b.Detail) > 0 {
					d = b.Detail[0]
				}
				e.out("  - " + b.Text + ": " + d)
			}
			return cmdErr{1}
		}
		sc := ""
		if rv.Score != 0 {
			sc = " (score " + fmtScore(rv.Score) + ")"
		}
		if err := e.write(p.G("signoff.md"), "---\nspec_hash: "+p.specHash()+"\napproved_by: "+by+"\napproved_on: "+p.today()+"\nreview: "+rv.Verdict+sc+"\n---\nThe client signed off the reviewed specification (living specs, glossary, ADRs, capability files). A later change to any of them makes this sign-off stale.\n"); err != nil {
			return err
		}
		e.out("recorded: spec signed off by " + by)
	default:
		return e.usage(`approve <understood|spec> --by "<name>"`)
	}
	return nil
}

func (e *Env) cmdReview(p *Project, o opts) error {
	kind := ""
	if len(o.args) > 0 {
		kind = o.args[0]
	}
	if kind != "spec" && kind != "plan" && kind != "dryrun" {
		return e.usage("review <spec|plan|dryrun> --packet [--out FILE] | --reply FILE | --reviewer none --reason TEXT")
	}
	if o.flags["packet"] {
		if err := e.guardKind(p, "read", o); err != nil {
			return err
		}
		t := p.Packet(kind)
		if of := o.val["out"]; of != "" {
			f := of
			if !filepath.IsAbs(f) {
				f = filepath.Join(e.Cwd, f)
			}
			if err := e.write(f, t); err != nil {
				return err
			}
			e.out("wrote " + p.Rel(f) + " (give this file to the spec-reviewer subagent; it is not committed)")
		} else {
			_, _ = fmt.Fprint(e.Out, t)
		}
		return nil
	}
	if err := e.guardKind(p, "write", o); err != nil {
		return err
	}
	switch o.val["reviewer"] {
	case "self":
		e.out(`refused: the agent that wrote the spec cannot review it; use the spec-reviewer subagent, or --reviewer none --reason "<why>" to record a waiver`)
		return cmdErr{1}
	case "none":
		reason := o.val["reason"]
		if len(strings.TrimSpace(reason)) < 10 {
			return e.usage(`--reviewer none needs --reason "<why, at least 10 characters>"`)
		}
		if _, err := p.writeReview(kind, &reply{Verdict: "waived", Reviewer: "none", Reason: reason}); err != nil {
			fmt.Fprintln(e.Err, err)
			return cmdErr{1}
		}
		e.out(fmt.Sprintf("recorded: %s review waived (%s); it is listed in the handover manifest", kind, reason))
		return nil
	}
	rf := o.val["reply"]
	if rf == "" {
		return e.usage("review needs --reply FILE (or - for stdin)")
	}
	var text string
	if rf == "-" {
		b, _ := io.ReadAll(e.In)
		text = string(b)
	} else {
		f := rf
		if !filepath.IsAbs(f) {
			f = filepath.Join(e.Cwd, f)
		}
		t, ok := read(f)
		if !ok {
			return e.usage("cannot read " + rf)
		}
		text = t
	}
	r, msg := parseReply(text, kind)
	if r == nil {
		e.out("reply rejected: " + msg + ". Nothing was recorded.")
		return cmdErr{2}
	}
	r.Reviewer = "subagent"
	rounds, err := p.writeReview(kind, r)
	if err != nil {
		fmt.Fprintln(e.Err, err)
		return cmdErr{1}
	}
	sc := ""
	if r.Score != nil {
		sc = fmt.Sprintf(", score %d", *r.Score)
	}
	e.out(fmt.Sprintf("recorded: %s review %s%s, %d blocker(s), %d major (round %d)", kind, r.Verdict, sc, r.Blockers, r.Majors, rounds))
	if r.Verdict != "pass" {
		return cmdErr{1}
	}
	return nil
}

func (e *Env) cmdRoadmap(p *Project, o opts) error {
	if err := e.guardKind(p, "read", o); err != nil {
		return err
	}
	rm := p.Roadmap()
	fail := func() error {
		if !rm.OK {
			return cmdErr{1}
		}
		return nil
	}
	if o.flags["json"] {
		e.json(rm)
		return fail()
	}
	if o.flags["next"] {
		switch {
		case len(rm.NextUp) > 0:
			e.out(strings.Join(rm.NextUp, "\n"))
		case len(rm.Slices) > 0:
			e.out("(no slice is ready: all done, or every open slice waits for a dependency)")
		default:
			e.out("(no slices)")
		}
		return fail()
	}
	c := rm.Counts
	e.out(fmt.Sprintf("roadmap: %d slice(s); %d done, %d in progress, %d planned", len(rm.Slices), c["done"], c["applying"]+c["proposed"], c["planned"]))
	for i, s := range rm.Slices {
		need := ""
		if s.RequiredSize != "" && s.RequiredSize != s.Size {
			need = ", needs " + s.RequiredSize
		}
		sk, after := "", ""
		if s.Skeleton {
			sk = " skeleton"
		}
		if len(s.DependsOn) > 0 {
			after = "  after " + strings.Join(s.DependsOn, ", ")
		}
		e.out(fmt.Sprintf("  %2d. %s  [%s%s] %s %s%s%s", i+1, s.ID, s.Size, need, s.Milestone, s.Status, sk, after))
	}
	if len(rm.NextUp) > 0 {
		e.out("next up: " + strings.Join(rm.NextUp, ", "))
	}
	for _, x := range rm.Errors {
		e.out("ERROR " + x.Code + ": " + x.Text)
	}
	for _, x := range rm.Warnings {
		e.out("warning " + x.Code + ": " + x.Text)
	}
	if rm.OK {
		e.out("roadmap OK")
	} else {
		e.out(fmt.Sprintf("roadmap has %d error(s)", len(rm.Errors)))
	}
	return fail()
}

func (e *Env) cmdHandover(p *Project, o opts) error {
	w := o.flags["write"]
	if w {
		if err := e.guardKind(p, "write", o); err != nil {
			return err
		}
	} else {
		if err := e.guardKind(p, "read", o); err != nil {
			return err
		}
	}
	g := p.Gate()
	h := p.handoverState()
	man := p.Rel(p.G("handover.md"))
	if w && g.Ready {
		rev, err := p.writeHandover(g)
		if err != nil {
			fmt.Fprintln(e.Err, err)
			return cmdErr{1}
		}
		if o.flags["json"] {
			e.json(map[string]any{"ready": true, "manifest": man, "rev": rev})
		} else {
			e.out(fmt.Sprintf("READY FOR HANDOVER\nmanifest: %s (rev %d). Send the repository to the development team; they run /spec-green-next.", man, rev))
		}
		return nil
	}
	if o.flags["json"] {
		e.json(struct {
			Ready    bool      `json:"ready"`
			Gate     bool      `json:"gate"`
			Manifest *handover `json:"manifest"`
			Items    []Item    `json:"items"`
			Missing  []Item    `json:"missing"`
			Warnings []string  `json:"warnings"`
		}{g.Ready && h != nil && h.Current, g.Ready, h, g.Items, g.Missing, g.Warnings})
		if !g.Ready {
			return cmdErr{1}
		}
		return nil
	}
	if g.Ready {
		if h != nil && h.Current {
			e.out(fmt.Sprintf("READY FOR HANDOVER\nmanifest: %s (rev %d)", man, h.Rev))
		} else {
			e.out("The gate passes. Write the manifest: " + run("handover --write"))
		}
		return nil
	}
	e.out(fmt.Sprintf("NOT READY: %d item(s) missing", len(g.Missing)))
	for _, it := range g.Items {
		x := " "
		if it.OK {
			x = "x"
		}
		e.out(fmt.Sprintf("  [%s] %s", x, it.Text))
		for _, d := range it.Detail[:min(8, len(it.Detail))] {
			e.out("        - " + d)
		}
		if !it.OK {
			e.out("        fix: " + *it.Fix)
		}
	}
	for _, x := range g.Warnings {
		e.out("warning: " + x)
	}
	return cmdErr{1}
}

// InputsReadme writes inputs/README.md when the project is a new product (init calls it); it returns the step line or "".
func (p *Project) InputsReadme() string {
	if m := p.ModeFor("start"); m.Mode != Greenfield && m.Mode != InProgress {
		return ""
	}
	f := p.path("inputs", "README.md")
	if exists(f) {
		return ""
	}
	if os.MkdirAll(filepath.Dir(f), 0o755) != nil || os.WriteFile(f, []byte(InputsReadme), 0o644) != nil {
		return ""
	}
	return "inputs      -> " + p.Rel(f) + " (new product: put the client material here, then run /spec-green-start)"
}
