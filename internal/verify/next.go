package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/trace"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

// PacketTask is a task as the packet shows it.
type PacketTask struct {
	Label   string   `json:"label"`
	Title   string   `json:"title"`
	Details []string `json:"details"`
}

// batchTasks: what one `next` hands out: Size S the whole change, Size M/L one task group, no Size line one task; a
// review task goes alone.
func (e *Env) batchTasks(changeDir string, ts []taskRef, pending int) []taskRef {
	isReview := func(t taskRef) bool { return tasks.IsReview(t.T.Label, t.T.Title) }
	size := quality.ReadProposalSize(readText(filepath.Join(changeDir, "proposal.md"))).Size
	scope := "group"
	switch {
	case e.O.PerTask || size == "" || isReview(ts[pending]):
		return ts[pending : pending+1]
	case size == "S":
		scope = "change"
	}
	out := []taskRef{ts[pending]}
	g0 := ts[pending].T.Group
	for k := pending + 1; k < len(ts); k++ {
		t := ts[k]
		if t.Done || isReview(t) || (scope == "group" && t.T.Group != g0) {
			break
		}
		out = append(out, t)
	}
	return out
}

func memberLabel(ms []Member) string {
	if len(ms) > 1 {
		return ms[0].Label + "-" + ms[len(ms)-1].Label
	}
	return ms[0].Label
}

// Next hands out the next task (or batch) of a change as a packet for one implementer subagent.
func (e *Env) Next() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	if err := e.Begin(); err != nil {
		return err
	}
	if b := filepath.Join(changeDir, "BLOCKED.md"); exists(b) {
		e.emit(O("result", "blocked", "blocked_file", b))
		return quit(Blocked)
	}
	ts, prog, err := loadTasks(changeDir)
	if err != nil {
		return err
	}
	files := []string{tasksFile(changeDir)}
	if bad := e.lintReport(files); len(bad) > 0 {
		e.emit(O("result", "ambiguous-tasks", "problems", bad, "fix", "Move example checkboxes out of code fences and turn nested checkboxes into plain detail lines (`- Spec:` etc.), then rerun. Use /spec-fix if the plan must change."))
		return quit(Usage)
	}
	tinfo := e.testCmd()
	if p := testCmdProblem(tinfo); p != "" {
		e.emit(O("result", "config", "problem", p))
		e.say("REFUSED: %s", p)
		return quit(Usage)
	}
	vl := e.visualLint(changeDir)
	var vbad []VProblem
	for _, p := range vl.problems {
		if p.severity() == "error" {
			vbad = append(vbad, p)
		}
	}
	if len(vbad) > 0 {
		e.emit(O("result", "visual-spec", "problems", vbad, "fix", "Fix the ```visual blocks or Visual: lines with /spec-fix (specs and tasks are planning artifacts), then rerun."))
		return quit(Usage)
	}
	var pbad []PlanFinding
	for _, p := range slices.Concat(pf(e.planProblems(changeDir), nil), pf(e.sizeReport(changeDir).Problems, nil), pf(e.whyReport(changeDir).Problems, nil)) {
		if p.Severity == "error" {
			pbad = append(pbad, p)
		}
	}
	if len(pbad) > 0 {
		e.emit(O("result", "plan", "problems", pbad, "fix", "Re-plan with /spec-fix (merge tasks, or change Size: in proposal.md and write the full artifacts for that size; Why problems: fix the Why lines of the delta specs and the Owner approval line), then rerun."))
		return quit(Usage)
	}
	if e.O.NewRun {
		if old := e.currentRun(false); old != "" {
			closeRun(e, old, "superseded")
		}
	}
	run := e.currentRun(false)
	var st *State
	if run != "" && exists(filepath.Join(run, "state.json")) {
		st, _ = readState(run)
	}
	if st != nil && st.Exhausted {
		e.emit(O("result", "exhausted", "task", st.Task, "run", run))
		return quit(Exhausted)
	}
	if st != nil && st.Review != nil && st.Task != nil {
		e.emit(O("result", "review-pending", "task", st.Task.Label, "review_prompt", st.Review.Prompt, "fix", fmt.Sprintf("dispatch spec-visual-reviewer with %s, then run `review %s --reply <file>`", st.Review.Prompt, e.O.Change)))
		return quit(Usage)
	}
	// A ticked task that no check passed (re-ticked after a failed check, or ticked without one) is never skipped.
	ledger := e.readLedger(ts)
	foreign := e.foreignRecords(ts, ledger)
	var unverified []string
	for _, t := range ts {
		if _, f := foreign[t.Desc]; t.Done && (!ledger.Verified(t.Desc) || f) {
			unverified = append(unverified, t.Desc)
		}
	}
	if len(unverified) > 0 {
		cur := st != nil && st.Task != nil && slices.Contains(unverified, st.Task.Description)
		var others []string
		for _, d := range unverified {
			if !cur || d != st.Task.Description {
				others = append(others, d)
			}
		}
		var fix string
		if cur {
			fix = fmt.Sprintf("task %s is ticked in tasks.md but has no passing check: run `check %s --reported done` now (it verifies the tick; after a failed check it opens the next attempt itself, no `next` needed)", st.Task.Label, e.O.Change)
			if len(others) > 0 {
				fix += "; also untick " + strings.Join(others, "; ")
			}
		} else {
			fix = fmt.Sprintf("tasks.md has ticked tasks that no check passed: %s. Untick them (`- [ ]`) and rerun `next %s`: it hands out the first unticked task and `check` verifies it. Never tick a task without `check`", strings.Join(others, "; "), e.O.Change)
		}
		x := O("result", "unverified-ticks", "tasks", unverified)
		if len(foreign) > 0 {
			x.Set("foreign", foreign)
		}
		e.emit(x.Set("fix", fix))
		e.say("REFUSED: %s", fix)
		return quit(Usage)
	}
	pending := slices.IndexFunc(ts, func(t taskRef) bool { return !t.Done })
	if pending < 0 {
		if run != "" {
			closeRun(e, run, "complete")
		}
		var fin *runstate.Record
		var f runstate.Record
		if runstate.ReadJSON(filepath.Join(e.runsDir(), "finished.json"), &f) {
			fin = &f
		}
		e.emit(O("result", "complete", "progress", prog, "status", runstate.Summary(e.readLedger(nil), fin, runstate.Fingerprinted(e.code, true), len(ts))))
		return quit(Done)
	}
	r := run
	if r == "" {
		r = e.currentRun(true)
	}
	if st != nil && st.Wave != nil {
		return e.emitWave(changeDir, r, st, vl, tinfo, prog, false)
	}
	fresh := false
	if st == nil || st.Task == nil || st.Task.Description != ts[pending].Desc {
		fresh = true
		waves := 0
		if st != nil {
			waves = st.Waves
		}
		var snaps []Snap
		for i, f := range files {
			snap := filepath.Join(r, "pre", fmt.Sprintf("%d-%d.md", nowMillis(), i))
			_ = os.MkdirAll(filepath.Dir(snap), 0o755)
			b, _ := os.ReadFile(f)
			_ = os.WriteFile(snap, b, 0o644)
			snaps = append(snaps, Snap{File: f, Snap: snap})
		}
		pre := []PreTask{}
		for _, t := range ts {
			pre = append(pre, PreTask{t.Desc, t.Done})
		}
		if wt := e.waveTasks(changeDir, ts, pending); len(wt) > 0 {
			w := &Wave{N: waves + 1}
			for _, t := range wt {
				w.Lanes = append(w.Lanes, &Lane{Task: TaskState{Member: memberOf(t.T, t.File)}, Status: laneOpen})
			}
			w.Hashes = e.waveHashes(w.Lanes)
			st = &State{Change: e.O.Change, Started: runstate.Now(), PreTasks: pre, Snapshots: snaps, Wave: w, Waves: w.N}
			logMetric(r, O("event", "dispatch", "wave", w.N, "tasks", w.labels(), "remaining", prog.Remaining))
			e.recordBase()
			writeState(r, st)
			return e.emitWave(changeDir, r, st, vl, tinfo, prog, true)
		}
		var members []Member
		for _, t := range e.batchTasks(changeDir, ts, pending) {
			members = append(members, memberOf(t.T, t.File))
		}
		task := &TaskState{Member: members[0]}
		task.Label = memberLabel(members)
		if len(members) > 1 {
			task.Members = members
			task.Details = nil
			for _, m := range members {
				task.Details = append(task.Details, m.Details...)
			}
		}
		st = &State{Change: e.O.Change, Started: runstate.Now(), Task: task, PreTasks: pre, Snapshots: snaps, Waves: waves}
		logMetric(r, O("event", "dispatch", "task", task.Label, "remaining", prog.Remaining))
		e.recordBase()
	}
	st.AttemptOpen = true
	writeState(r, st)
	packet, prompt, err := e.packetFor(changeDir, r, st, vl, tinfo, prog, fresh)
	if err != nil {
		return err
	}
	if e.O.Format == "prompt" {
		e.timelineOf(packet)
		fmt.Fprintln(e.Out, prompt)
		return nil
	}
	e.emit(packet)
	return nil
}

// emitWave hands out the open lanes of a parallel wave: one packet per task, for implementers running at once.
func (e *Env) emitWave(changeDir, r string, st *State, vl vlint, tinfo CmdInfo, prog Progress, fresh bool) error {
	w := st.Wave
	var packets []any
	var prompts, labels, reviews []string
	if fresh {
		// One "before" capture for the whole wave (one server, one browser), shared by its lanes.
		e.captureWaveBefore(r, changeDir, st)
	}
	for i, l := range w.Lanes {
		if l.Status == lanePassed || l.Status == laneExhausted {
			continue
		}
		if l.Review != nil {
			reviews = append(reviews, l.Task.Label)
			continue
		}
		l.Status = laneOpen
		e.wave, e.lane = w.N, i+1
		v := st.laneView(l)
		v.AttemptOpen = true
		writeState(r, v)
		obj, prompt, err := e.packetFor(changeDir, r, v, vl, tinfo, prog, fresh && len(v.VisualBefore) == 0)
		if err != nil {
			return err
		}
		e.timelineOf(obj)
		packets = append(packets, obj)
		prompts = append(prompts, prompt)
		labels = append(labels, l.Task.Label)
	}
	e.lane = 0
	if len(packets) == 0 && len(reviews) > 0 {
		e.emit(O("result", "review-pending", "task", strings.Join(reviews, ", "), "wave", waveObj(st), "fix", fmt.Sprintf("dispatch spec-visual-reviewer for each task waiting for its review, then run `review %s --task <label> --reply <file>`", e.O.Change)))
		return quit(Usage)
	}
	if len(packets) == 0 {
		e.emit(O("result", "exhausted", "task", strings.Join(w.labels(laneExhausted), ", "), "run", r, "wave", waveObj(st)))
		return quit(Exhausted)
	}
	how := fmt.Sprintf("dispatch these %d packets at once, one spec-implementer subagent each; as each returns, run `check %s --task <label> --reported <status>` for it (one check at a time)", len(packets), e.O.Change)
	if e.O.Format == "prompt" {
		var b strings.Builder
		fmt.Fprintf(&b, "WAVE %d: %d tasks (%s) for parallel implementers: %s.\n", w.N, len(packets), strings.Join(labels, ", "), how)
		for i, p := range prompts {
			fmt.Fprintf(&b, "\n=== packet %s ===\n%s\n", labels[i], p)
		}
		_, _ = fmt.Fprint(e.Out, b.String())
		return nil
	}
	x := O("result", "wave", "change", e.O.Change, "run", r, "wave", w.N, "tasks", labels, "packets", packets, "progress", prog, "next", how)
	if e.status != "" {
		x.Set("run_status", e.status)
	}
	e.print(x)
	return nil
}

// packetFor builds the packet of one dispatch (a task, a batch or one lane of a wave) and its prompt.
func (e *Env) packetFor(changeDir, r string, st *State, vl vlint, tinfo CmdInfo, prog Progress, fresh bool) (*Obj, string, error) {
	warnings := []string{}
	if tinfo.State == "none" {
		warnings = append(warnings, "the project test command is disabled (commands.test: none); only Done when and validate are checked")
	}
	vt, _ := resolveRefs(visualRefs(st.Task.Details), vl.scenarios)
	vcfg := e.Cfg.Visual
	if len(vt) > 0 {
		if vp := visual.ConfigProblem(vcfg); vp != "" {
			st.AttemptOpen = false
			writeState(r, st)
			e.emit(O("result", "config", "problem", vp))
			e.say("REFUSED: task %s names visual scenarios but %s", st.Task.Label, vp)
			return nil, "", quit(Usage)
		}
		if vcfg.Off {
			warnings = append(warnings, "task names visual scenarios but `visual: off` in wingman-spec.yaml: nothing visual will be checked")
		}
	}
	if fresh {
		// The task's "before": the declared scenarios as they are now, before the implementer edits anything.
		if vb := e.captureBefore(r, changeDir, st); vb != nil {
			st.VisualBefore = vb
			writeState(r, st)
			var b struct {
				OK      bool     `json:"ok"`
				Seconds float64  `json:"seconds"`
				Source  string   `json:"source"`
				Skipped string   `json:"skipped"`
				Server  []string `json:"server"`
			}
			_ = jsonUnmarshal(vb, &b)
			logMetric(r, O("event", "visual-before", "task", st.Task.Label, "ok", b.OK, "seconds", b.Seconds, "source", b.Source))
			if !b.OK {
				why := b.Skipped
				if why == "" {
					why = strings.Join(b.Server, ", ")
				}
				if why == "" {
					why = "unknown"
				}
				warnings = append(warnings, fmt.Sprintf("could not capture the pre-task state of the visual scenarios (%s); check will try a git worktree of HEAD", why))
			}
		}
	}
	scens := quality.SpecScenarios(filepath.Join(changeDir, "specs"))
	tr := specRefsOf(st, scens)
	tagIDs := func(xs []*quality.Scenario) []string {
		out := []string{}
		for _, x := range xs {
			if !x.Visual || vcfg.Off {
				out = append(out, x.ID)
			}
		}
		return out
	}
	anchorKeys := []string{}
	if trace.Mode(e.Cfg) != "off" {
		for _, x := range append(slices.Clone(tr.Explicit), tr.Implicit...) {
			if x.Requirement != "" {
				if k := x.Capability + "/" + spec.Slug(x.Requirement); !slices.Contains(anchorKeys, k) {
					anchorKeys = append(anchorKeys, k)
				}
			}
		}
	}
	var read []string
	for _, f := range []string{"proposal.md", "specs", "design.md", "design-map.md", "adrs", "tasks.md", "progress.md"} {
		if p := filepath.Join(changeDir, f); exists(p) {
			read = append(read, p)
		}
	}
	earlier := []string{}
	for _, t := range tasks.Parse(readText(tasksFile(changeDir))).All() {
		if t.Done && !t.Review {
			s := t.Label + " " + t.Title
			if len(t.Files) > 0 {
				s += " (" + strings.Join(t.Files, ", ") + ")"
			}
			earlier = append(earlier, s)
		}
	}
	var batch []PacketTask
	for _, m := range st.members() {
		batch = append(batch, PacketTask{m.Label, m.Title, list(m.Details)})
	}
	var vports []int
	refs := []string{}
	for _, s := range vt {
		for _, v := range s.Viewports {
			if !slices.Contains(vports, v) {
				vports = append(vports, v)
			}
		}
		if s.Reference != "" || len(s.References) > 0 {
			if p := visual.ResolveReference(s, s.Reference, changeDir, e.R.Specs, e.code); p != "" {
				refs = append(refs, p)
			}
		}
	}
	slices.Sort(vports)
	var rr any = Skip
	if tasks.IsReview(st.Task.Label, st.Task.Title) {
		if x := runstate.ReviewRange(e.code, e.changeBase()); x != nil {
			rr = x
		}
	}
	pt := &PacketTask{st.Task.Label, st.Task.Title, list(st.Task.Details)}
	packet := O("result", "task", "change", e.O.Change, "specs_root", e.R.Specs, "code_root", e.code, "change_dir", changeDir, "run", r,
		"task", pt, "batch", batch, "done_when", st.Task.DoneWhen.Cmd, "test_cmd", tinfo.Cmd, "read", read, "earlier", earlier,
		"attempt", st.Attempts+1, "max_attempts", e.O.MaxAttempts, "last_failure", st.LastFailure, "progress", prog,
		"visual", O("scenarios", ids(vt), "viewports", list(vports), "references", refs, "self_check", "wingman-spec visual "+e.O.Change, "guards", vcfg.Scope == "all"),
		"trace", O("scenarios", tagIDs(tr.Explicit), "requirement_level", tagIDs(tr.Implicit)),
		"anchors", anchorKeys, "warnings", warnings, "review_range", rr)
	for _, w := range warnings {
		e.say("WARNING: %s", w)
	}
	prompt := e.packetPrompt(changeDir, st, batch, read, earlier, warnings, ids(vt), vports, refs, vcfg.Scope == "all", tagIDs(tr.Explicit), tagIDs(tr.Implicit), anchorKeys, rr)
	if st.lane != nil {
		packet.Set("wave", st.parent.Wave.N).Set("files", filesOf(st.Task.Details)).Set("check", fmt.Sprintf("check %s --task %s --reported <status>", e.O.Change, st.Task.Label))
	}
	return packet, prompt, nil
}

var designMapRE = regexp.MustCompile(`(^|/)design-map\.md$`)

// packetPrompt is the packet as a ready prompt for one implementer subagent.
func (e *Env) packetPrompt(changeDir string, st *State, batch []PacketTask, read, earlier, warnings, vscen []string, vports []int, refs []string, guards bool, tags, reqTags, anchorKeys []string, rr any) string {
	rel := func(f string) string {
		if e.R.Specs == e.code {
			if r, err := filepath.Rel(e.code, f); err == nil {
				return r
			}
		}
		return f
	}
	var L []string
	add := func(s ...string) {
		for _, x := range s {
			if x != "" {
				L = append(L, x)
			}
		}
	}
	if len(batch) > 1 {
		add(fmt.Sprintf("Implement these %d tasks, in order, of the change `%s` (change directory: `%s`); the verifier checks them together after you reply.", len(batch), e.O.Change, rel(changeDir)))
	} else {
		add(fmt.Sprintf("Implement exactly ONE task of the change `%s` (change directory: `%s`).", e.O.Change, rel(changeDir)))
	}
	for _, b := range batch {
		L = append(L, fmt.Sprintf("Task %s: %s", b.Label, b.Title))
		for _, d := range b.Details {
			L = append(L, "  "+d)
		}
	}
	var rd []string
	for _, f := range read {
		rd = append(rd, rel(f))
	}
	add("Read first: " + strings.Join(rd, ", ") + ".")
	if len(earlier) > 0 {
		add("Already done in this change: " + strings.Join(earlier, "; ") + ".")
	}
	if st.Attempts > 0 {
		lf := ""
		if st.LastFailure != nil {
			lf = *st.LastFailure
		}
		add(fmt.Sprintf("This is attempt %d of %d. The previous attempt was rejected by the verifier:\n%s", st.Attempts+1, e.O.MaxAttempts, lf))
	}
	if len(vscen) > 0 {
		var vp []string
		for _, v := range vports {
			vp = append(vp, fmt.Sprint(v))
		}
		g := ""
		if guards {
			g = ", and on any change to OTHER declared scenarios outside this task's Files: (it compared them before you started)"
		}
		dr := ""
		cmp := "compare with the scenario text"
		if len(refs) > 0 {
			dr = " and the design reference"
			cmp = "compare with " + strings.Join(refs, ", ")
		}
		add(fmt.Sprintf("Visual scenarios for this task: %s. The verifier opens each scenario state at %spx and fails on console or page errors, failed requests, axe violations, sideways scrolling, missing/hidden/offscreen/overlapping key elements and broken images%s. `finish` checks every other declared scenario against the state before the change. Then a reviewer compares before/after images of the affected areas with the scenario%s.\nBefore you reply, run `wingman-spec visual %s`, fix every defect it lists, read its ARIA changes, and open the after images it lists to look at them yourself (%s).",
			strings.Join(vscen, ", "), strings.Join(vp, "/"), g, dr, e.O.Change, cmp))
	}
	const behaviour = "Tests assert behaviour (results, rendered DOM), never source text: no `?raw` imports or readFileSync of source files."
	if len(tags)+len(reqTags) > 0 {
		s := "Tag the test that proves each scenario with its id in square brackets in the test title: " + bracket(append(slices.Clone(tags), reqTags...))
		if len(reqTags) > 0 {
			s += " (those of " + bracket(reqTags) + " that this task implements)"
		}
		add(s + ". The verifier fails the task when a scenario it names has no tagged test. " + behaviour)
	} else {
		add(behaviour)
	}
	if len(anchorKeys) > 0 {
		var ms []string
		for _, k := range anchorKeys {
			ms = append(ms, "@spec "+k)
		}
		add("Code anchors: put a comment `@spec <capability>/<requirement-slug>` (any comment syntax) on the one function (or the few lines) that decides each requirement's observable behaviour, once per code path: whole function: once in its doc comment; part of a function: once on its own line directly above those lines; never on an import, constant, type, string or i18n table, getter, logging or plumbing line, never in another feature's file, never at the end of a code line or the top of a multi-function file, never because the code is merely used by or visible after the behaviour; a requirement with no distinct code of its own gets its test tag only. And the same marker (or a [capability/scenario-slug] test tag) in its test: " + strings.Join(ms, ", ") + ". The verifier rejects a marker that does not resolve and finish fails a requirement with no code anchor or no test anchor; you write only the comments; the verifier derives the index from them on demand (nothing to commit).")
	}
	if slices.ContainsFunc(read, designMapRE.MatchString) {
		add("This change implements a design: build the UI with exactly what design-map.md names (project tokens, then components and their variants, framework defaults only where it says so). No new hex colours, px values or arbitrary classes (`p-[13px]`) unless the map lists them under Gaps; the verifier rejects hard-coded values that equal a project token, and the visual check measures its `expect:` lines.")
	}
	if r, ok := rr.(*runstate.Range); ok {
		add(fmt.Sprintf("Code review range for the requesting-code-review skill: BASE_SHA=%s HEAD_SHA=%s. HEAD_SHA is a snapshot of the working tree with every uncommitted and untracked file; `git diff BASE_SHA HEAD_SHA` is the whole change. Use these two values; do not run git rev-parse or git merge-base for the range.", r.Base, r.Head))
	}
	for _, w := range warnings {
		add("WARNING: " + w)
	}
	if others := st.otherOpenLanes(); st.lane != nil && len(others) > 0 {
		add(fmt.Sprintf("Other implementers are working in this same tree at the same time (tasks %s). Edit only the files of this task: %s, plus the tests for them. Do not run the full test suite, do not format or lint the whole repository, do not install or update dependencies, and do not touch any other file: the verifier rejects an edit to a file no task of the wave names.", strings.Join(others, ", "), strings.Join(filesOf(st.Task.Details), ", ")))
	}
	add("Do not edit tasks.md (the verifier ticks the task when its checks pass), specs or ADRs, and do not commit. If the task cannot be done as specified, write BLOCKED.md in the change directory.",
		"End your reply with one line: `STATUS: done`, `STATUS: failed` or `STATUS: blocked`.")
	return strings.Join(L, "\n")
}
