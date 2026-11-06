package verify

import (
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

// Anchors reports @spec markers that do not match a requirement, and the requirement index when --json is set.
func (e *Env) Anchors() error {
	md := trace.Mode(e.Cfg)
	dir := filepath.Join(e.R.Specs, ".none")
	if e.O.Change != "" {
		d, err := e.changeDir()
		if err != nil {
			return err
		}
		dir = d
	}
	r := e.tr().AnchorLint(dir)
	m := md
	if m == "off" {
		m = "on"
	}
	problems := list(trace.BySeverity(r.Problems, m))
	bad := slices.ContainsFunc(problems, func(p trace.Problem) bool { return p.Severity == "error" })
	cov := e.tr().CoverageOf(r.Eff)
	reqs := O()
	keys := make([]string, 0, len(r.Facts.Requirements))
	for k := range r.Facts.Requirements {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if e.O.Change != "" && !slices.Contains(r.Mine, k) {
			continue
		}
		x := r.Facts.Requirements[k]
		reqs.Set(k, O("code", append([]string{}, slices.Sorted(maps.Keys(x.Code))...), "tests", append([]string{}, slices.Sorted(maps.Keys(x.Tests))...), "coverage", cov[k]))
	}
	var index any = Skip
	if e.O.JSON {
		index = trace.AnchorIndex(r.Eff, r.Facts)
	}
	e.print(O("ok", !bad, "mode", md, "summary", r.Summary, "problems", problems, "index", index, "requirements", reqs, "coverage", e.coverageObj(cov), "skipped", e.skippedObj(), "markers", If(e.O.JSON, r.Facts.Markers)))
	if bad {
		return quit(Fail)
	}
	return nil
}

// coverageObj summarizes the recorded test results: where they live and the requirement count per state.
func (e *Env) coverageObj(cov map[string]trace.Coverage) *Obj {
	p := e.tr().ResultsPath()
	return O("results", If(layout.Exists(p), rel(e.code, p)), "counts", trace.CoverageCounts(cov))
}

var selectRE = regexp.MustCompile(`^(.*):(\d+)$`)

// AnchorsPrune lists (or with --apply removes) the markers anchor_fit flags as removable; the last code anchor stays.
func (e *Env) AnchorsPrune() error {
	tr := e.tr()
	fit, level := tr.FitProblems(nil, nil)
	left := map[string]int{}
	for _, m := range tr.ScanAnchors(nil) {
		if !testpaths.IsTestPath(m.File) {
			left[m.Key]++
		}
	}
	type cand struct {
		anchors.FitFinding
		none bool
	}
	var cands []cand
	if len(e.O.Select) > 0 {
		for _, s := range e.O.Select {
			m := selectRE.FindStringSubmatch(s)
			if m == nil {
				return die(Usage, "--select wants <file>:<line>, got '%s'", s)
			}
			line := toInt(m[2])
			i := slices.IndexFunc(fit, func(f anchors.FitFinding) bool { return f.File == m[1] && f.Line == line })
			if i < 0 {
				cands = append(cands, cand{anchors.FitFinding{File: m[1], Line: line}, true})
			} else {
				cands = append(cands, cand{fit[i], false})
			}
		}
	} else {
		for _, f := range fit {
			if f.Remove {
				cands = append(cands, cand{f, false})
			}
		}
	}
	var picks []anchors.RemovePick
	removable := []any{}
	refused := []any{}
	for _, x := range cands {
		why := ""
		switch {
		case x.none:
			refused = append(refused, O("file", x.File, "line", x.Line, "why", "not an over-anchored marker (anchor_fit has no finding there)"))
			continue
		case x.Kind == "many-anchors":
			why = "an info line about the count, not a marker to remove: anchors that pass the fit stay"
		case !x.Remove:
			why = "it is the requirement's only code anchor: move it, do not remove it"
		case left[x.Key] <= 1:
			why = "would leave the requirement without a code anchor"
		}
		if why != "" {
			refused = append(refused, O("file", x.File, "line", x.Line, "key", x.Key, "why", why))
			continue
		}
		left[x.Key]--
		picks = append(picks, anchors.RemovePick{File: x.File, Line: x.Line, Key: x.Key})
		removable = append(removable, O("file", x.File, "line", x.Line, "key", x.Key, "kind", x.Kind))
	}
	texts := map[string]string{}
	for _, p := range picks {
		if _, ok := texts[p.File]; !ok {
			texts[p.File] = layout.Text(filepath.Join(e.code, p.File))
		}
	}
	removed := 0
	if e.O.Apply {
		for f, t := range anchors.RemoveMarkers(texts, picks) {
			if t == texts[f] {
				continue
			}
			if err := os.WriteFile(filepath.Join(e.code, f), []byte(t), 0o644); err != nil {
				return die(Fail, "cannot write %s: %v", f, err)
			}
			for _, p := range picks {
				if p.File == f {
					removed++
				}
			}
		}
	}
	note := "nothing changed: add --apply to remove these markers (or --select file:line,... to pick)"
	if e.O.Apply {
		note = "marker lines removed; run `wingman-spec drift` to see what is left"
	}
	e.print(O("ok", true, "level", level, "applied", e.O.Apply, "removable", removable, "removed", removed, "refused", refused, "note", note))
	return nil
}

// Guard is the anchor guard over the change's diff (base: --base, else the commit `next` recorded, else HEAD).
func (e *Env) Guard() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	base := e.O.Base
	if base == "" {
		base = e.changeBase()
	}
	if base == "" {
		base = "HEAD"
	}
	rep, lvl := e.guardReport(changeDir, base, "change", nil)
	if rep == nil {
		e.print(O("ok", true, "level", "off", "note", "anchor guard is off (anchor_guard: off or traceability: off)"))
		return nil
	}
	bad := lvl == "error" && len(rep.Findings) > 0
	e.print(O("ok", !bad, "level", lvl, "base", base, "files", list(rep.Files), "findings", list(rep.Findings)))
	if bad {
		return quit(Fail)
	}
	return nil
}
