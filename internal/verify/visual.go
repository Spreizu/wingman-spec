package verify

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/gitx"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/spec"
	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

// vrefs is a `Visual:` detail line: all, or scenario ids as written.
type vrefs struct {
	all bool
	ids []string
}

var (
	visualLineRE = regexp.MustCompile(`(?i)^Visual:\s*`)
	visualNoneRE = regexp.MustCompile(`(?i)^(none|-|n/a)?$`)
	visualAllRE  = regexp.MustCompile(`(?i)^all\b`)
	refSepRE     = regexp.MustCompile(`\s*[,;]\s*`)
)

func visualRefs(details []string) vrefs {
	for _, d := range details {
		if !visualLineRE.MatchString(d) {
			continue
		}
		v := strings.TrimSpace(strings.ReplaceAll(visualLineRE.ReplaceAllString(d, ""), "`", ""))
		switch {
		case visualNoneRE.MatchString(v):
			return vrefs{}
		case visualAllRE.MatchString(v):
			return vrefs{all: true}
		}
		var ids []string
		for _, x := range refSepRE.Split(v, -1) {
			if x = strings.TrimSpace(x); x != "" {
				ids = append(ids, x)
			}
		}
		return vrefs{ids: ids}
	}
	return vrefs{}
}

func vslug(s string) string {
	if x := spec.Slug(s); x != "" {
		return x
	}
	return "scenario"
}

// resolveRefs finds the scenarios a Visual: line names: by id, by slug, or by scenario name.
func resolveRefs(r vrefs, scens []*visual.Scenario) (found []*visual.Scenario, unknown []string) {
	if r.all {
		return slices.Clone(scens), nil
	}
	for _, ref := range r.ids {
		k := strings.ToLower(ref)
		last := ref
		if _, after, ok := strings.CutLast(ref, "/"); ok {
			last = after
		}
		sl := vslug(last)
		var hit *visual.Scenario
		for _, s := range scens {
			if strings.ToLower(s.ID) == k {
				hit = s
				break
			}
		}
		if hit == nil {
			for _, s := range scens {
				if strings.HasSuffix(s.ID, "/"+sl) && (!strings.Contains(ref, "/") || s.Capability == strings.SplitN(ref, "/", 2)[0]) {
					hit = s
					break
				}
			}
		}
		if hit == nil {
			unknown = append(unknown, ref)
		} else if !slices.Contains(found, hit) {
			found = append(found, hit)
		}
	}
	return found, unknown
}

func (e *Env) scenarios(dir string) []*visual.Scenario {
	s, err := visual.Scenarios(e.Ctx, e.code, dir)
	if err != nil {
		e.say("WARNING: cannot read the visual blocks of %s: %v", e.R.Rel(dir), err)
	}
	return s
}

// vplan is what the visual check of one dispatch covers.
type vplan struct {
	cfg        config.Visual
	items      []visual.Item
	mine       []*visual.Scenario
	touched    []string
	declaredUI []string
	triggered  bool
}

// visualPlan: role task = the scenarios the dispatch's Visual: lines name; role change = those of earlier ticked tasks; role
// guard = every living scenario the change does not redefine (both only with visual.scope: all).
func (e *Env) visualPlan(changeDir string, st *State) vplan {
	cfg := e.Cfg.Visual
	scens := e.scenarios(filepath.Join(changeDir, "specs"))
	var det []string
	for _, m := range st.members() {
		det = append(det, m.Details...)
	}
	var mine []*visual.Scenario
	for _, m := range st.members() {
		f, _ := resolveRefs(visualRefs(m.Details), scens)
		for _, s := range f {
			if !slices.Contains(mine, s) {
				mine = append(mine, s)
			}
		}
	}
	var earlier []*visual.Scenario
	p := tasks.Parse(readText(tasksFile(changeDir)))
	isTarget := func(line int) bool {
		for _, m := range st.members() {
			if m.Line == line {
				return true
			}
		}
		return false
	}
	var allFiles []string
	for _, t := range p.All() {
		allFiles = append(allFiles, filesOf(t.Detail)...)
		if t.Done && !isTarget(t.Line) {
			f, _ := resolveRefs(visualRefs(t.Detail), scens)
			for _, s := range f {
				if !slices.Contains(earlier, s) {
					earlier = append(earlier, s)
				}
			}
		}
	}
	scope := filesOf(det)
	if tasks.IsReview(st.Task.Label, st.Task.Title) {
		scope = append(scope, allFiles...)
	}
	declared := map[string]bool{}
	for _, f := range scope {
		b := filepath.Base(f)
		declared[strings.ToLower(strings.TrimSuffix(b, filepath.Ext(b)))] = true
	}
	inScope := func(s *visual.Scenario) bool { return s.Component != "" && declared[strings.ToLower(s.Component)] }
	own := cfg.Scope == "task"
	shots := cfg.Screenshots != "off" && cfg.Review != "off"
	var items []visual.Item
	for _, s := range mine {
		items = append(items, visual.Item{Scenario: s, Role: "task", InScope: true, Shots: shots})
	}
	if !own {
		for _, s := range earlier {
			if !slices.Contains(mine, s) {
				items = append(items, visual.Item{Scenario: s, Role: "change", InScope: inScope(s)})
			}
		}
		ids := map[string]bool{}
		for _, s := range scens {
			ids[s.ID] = true
		}
		for _, s := range e.scenarios(e.R.LivingSpecs()) {
			if !ids[s.ID] {
				items = append(items, visual.Item{Scenario: s, Role: "guard", InScope: inScope(s)})
			}
		}
	}
	vp := vplan{cfg: cfg, items: items, mine: mine}
	for _, f := range filesOf(det) {
		if visual.IsUIFile(f, cfg) {
			vp.declaredUI = append(vp.declaredUI, f)
		}
	}
	src := e.changedFiles()
	if src == nil {
		src = filesOf(det)
	}
	for _, f := range src {
		if visual.IsUIFile(f, cfg) {
			vp.touched = append(vp.touched, f)
		}
	}
	vp.triggered = len(mine) > 0 || len(vp.touched) > 0
	return vp
}

func ids(xs []*visual.Scenario) []string {
	out := []string{}
	for _, s := range xs {
		out = append(out, s.ID)
	}
	return out
}

// visualConfigJSON is the visual config the helper reads.
func (e *Env) visualJob(extra map[string]any) map[string]any {
	j := map[string]any{"code_root": e.code, "root": e.R.Specs, "config": e.Cfg.Visual}
	maps.Copy(j, extra)
	return j
}

// captureBefore takes the dispatch's "before" capture (called by `next` while the tree is still pre-task).
func (e *Env) captureBefore(run, changeDir string, st *State) json.RawMessage {
	p := e.visualPlan(changeDir, st)
	if p.cfg.Off || visual.ConfigProblem(p.cfg) != "" || len(p.items) == 0 || (len(p.mine) == 0 && len(p.declaredUI) == 0) {
		return nil
	}
	var out json.RawMessage
	dir := filepath.Join(run, "visual", st.Task.Label, "before")
	if err := visual.Call(e.Ctx, e.code, "capture", e.visualJob(map[string]any{"out_dir": dir, "items": p.items}), &out, e.Err); err != nil {
		b, _ := json.Marshal(map[string]any{"dir": dir, "ok": false, "skipped": err.Error(), "server": []string{}, "source": "pre-task tree (next)"})
		return b
	}
	return out
}

// captureWaveBefore takes the "before" of every open lane of a wave in one helper job: the union of their scenarios (a
// scenario is role task when any lane names it, with area images when any lane wants them). Each lane keeps a reference
// to the shared report; the compare at its check reads only its own scenarios from it.
func (e *Env) captureWaveBefore(run, changeDir string, st *State) {
	var lanes []*Lane
	var items []visual.Item
	at := map[string]int{}
	var cfg config.Visual
	for _, l := range st.Wave.Lanes {
		if l.Status != laneOpen || l.Review != nil || len(l.VisualBefore) > 0 {
			continue
		}
		p := e.visualPlan(changeDir, st.laneView(l))
		cfg = p.cfg
		if p.cfg.Off || visual.ConfigProblem(p.cfg) != "" || len(p.items) == 0 || (len(p.mine) == 0 && len(p.declaredUI) == 0) {
			continue
		}
		lanes = append(lanes, l)
		for _, it := range p.items {
			k, ok := at[it.Scenario.ID]
			if !ok {
				at[it.Scenario.ID] = len(items)
				items = append(items, it)
				continue
			}
			if it.Role == "task" {
				items[k].Role = "task"
			}
			items[k].Shots = items[k].Shots || it.Shots
			items[k].InScope = items[k].InScope || it.InScope
		}
	}
	if len(lanes) == 0 || cfg.Off {
		return
	}
	var out json.RawMessage
	dir := filepath.Join(run, "visual", fmt.Sprintf("wave-%d", st.Wave.N), "before")
	if err := visual.Call(e.Ctx, e.code, "capture", e.visualJob(map[string]any{"out_dir": dir, "items": items}), &out, e.Err); err != nil {
		out, _ = json.Marshal(map[string]any{"dir": dir, "ok": false, "skipped": err.Error(), "server": []string{}, "source": "pre-task tree (next)"})
	}
	var b struct {
		OK      bool    `json:"ok"`
		Seconds float64 `json:"seconds"`
	}
	_ = json.Unmarshal(out, &b)
	logMetric(run, O("event", "visual-before", "wave", st.Wave.N, "lanes", len(lanes), "scenarios", len(items), "ok", b.OK, "seconds", b.Seconds))
	for _, l := range lanes {
		l.VisualBefore = out
	}
	writeState(run, st)
}

// vreport is the helper's visual report (only the fields the CLI reads are typed).
type vreport struct {
	Ran           bool     `json:"ran"`
	Skipped       *string  `json:"skipped"`
	Defects       []any    `json:"defects"`
	Shots         []any    `json:"shots"`
	ARIAChanges   []any    `json:"aria_changes"`
	Pairs         []any    `json:"pairs"`
	Preexisting   int      `json:"preexisting"`
	Seconds       float64  `json:"seconds"`
	Before        *string  `json:"before"`
	BeforeSeconds float64  `json:"before_seconds"`
	Warnings      []string `json:"warnings"`
	Summary       []string `json:"summary"`
	Ignored       []any    `json:"ignored"`
	IgnoredReport []string `json:"ignored_report"`
	SkippedSteps  []string `json:"skipped_steps"`
	AllDefects    int      `json:"all_defects"`
	Cached        bool     `json:"cached,omitempty"`
}

func (r *vreport) skipped() string {
	if r.Skipped == nil {
		return ""
	}
	return *r.Skipped
}

// visualCacheFile is the cache file of this exact visual run (visual.changed_only); "" when it does not apply.
func (e *Env) visualCacheFile(p vplan, st *State) string {
	if (!p.cfg.ChangedOnly && !e.O.Changed) || e.noCache() {
		return ""
	}
	for _, it := range p.items {
		if it.Shots || (it.Scenario.Role != "" && it.Scenario.Role != "anonymous") {
			return ""
		}
	}
	tree := runstate.AppTree(e.code)
	if tree == "" {
		return ""
	}
	var before any
	if st != nil && len(st.VisualBefore) > 0 {
		var vb struct{ Source, Report string }
		_ = json.Unmarshal(st.VisualBefore, &vb)
		before = []string{vb.Source, vb.Report}
	}
	cfg := p.cfg
	key, _ := json.Marshal([]any{tree, gitx.Head(e.code), before, p.items, cfg})
	s := sha1.Sum(key)
	return filepath.Join(e.runsDir(), "cache", "visual-"+hex.EncodeToString(s[:])+".json")
}

// runVisual runs the visual check of a plan and compares it with the before capture (cached while nothing changed).
func (e *Env) runVisual(changeDir string, p vplan, st *State, run, outDir string) vreport {
	vc := e.visualCacheFile(p, st)
	var hit struct {
		At      string  `json:"at"`
		Seconds float64 `json:"seconds"`
	}
	if vc != "" && runstate.ReadJSON(vc, &hit) {
		unchanged := "unchanged"
		return vreport{Ran: true, Defects: []any{}, Shots: []any{}, ARIAChanges: []any{}, Pairs: []any{}, Before: &unchanged, Cached: true,
			Warnings: []string{fmt.Sprintf("visual: nothing the pages are built from changed since the identical run that passed %s (%gs): not run again (visual.changed_only)", hit.At, hit.Seconds)}}
	}
	label := "self"
	var before json.RawMessage
	if st != nil {
		label = st.Task.Label
		before = st.VisualBefore
	}
	_ = os.MkdirAll(outDir, 0o755)
	var res struct {
		Report       vreport         `json:"report"`
		VisualBefore json.RawMessage `json:"visual_before"`
	}
	job := e.visualJob(map[string]any{"change_dir": changeDir, "out_dir": outDir, "items": p.items, "label": label, "run_dir": run})
	if len(before) > 0 {
		job["before"] = before
	}
	if err := visual.Call(e.Ctx, e.code, "run", job, &res, e.Err); err != nil {
		why := err.Error()
		return vreport{Skipped: &why, Defects: []any{}, Shots: []any{}, ARIAChanges: []any{}, Pairs: []any{}, Warnings: []string{"WARNING: the visual check was SKIPPED: " + why + " (never report it as passed)"}}
	}
	if st != nil && len(res.VisualBefore) > 0 && string(res.VisualBefore) != "null" {
		st.VisualBefore = res.VisualBefore
	}
	r := res.Report
	r.Defects, r.Shots, r.ARIAChanges, r.Pairs = list(r.Defects), list(r.Shots), list(r.ARIAChanges), list(r.Pairs)
	if vc != "" && r.Ran && r.skipped() == "" && len(r.Defects) == 0 {
		_ = os.MkdirAll(filepath.Dir(vc), 0o755)
		_ = runstate.WriteJSON(vc, map[string]any{"at": runstate.Now(), "seconds": r.Seconds})
	}
	return r
}
