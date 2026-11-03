package verify

import (
	"fmt"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/report"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

func isErrGap(g trace.Gap) bool { return g.Severity == "" || g.Severity == "error" }

func driftText(r trace.DriftReport) string {
	var errs, adv []trace.Gap
	for _, g := range r.Open {
		if isErrGap(g) {
			errs = append(errs, g)
		} else {
			adv = append(adv, g)
		}
	}
	hint := func(g trace.Gap) string {
		if g.Hint == "" {
			return ""
		}
		return "\n           hint: " + g.Hint
	}
	l := []string{fmt.Sprintf("drift: %d requirement(s); %d open gap(s) (+%d advisory), %d accepted", r.Requirements, len(errs), len(adv), len(r.Accepted))}
	for _, g := range errs {
		l = append(l, fmt.Sprintf("  OPEN     %s\n           %s%s", g.Key, g.Text, hint(g)))
	}
	for _, g := range adv {
		l = append(l, fmt.Sprintf("  %-8s %s  (advisory: does not fail drift)\n           %s%s", strings.ToUpper(g.Severity), g.Key, g.Text, hint(g)))
	}
	for _, n := range r.Notes {
		l = append(l, "  note: "+n)
	}
	if n := r.Observed["entries"]; n > 0 {
		w := "entries"
		if n == 1 {
			w = "entry"
		}
		l = append(l, fmt.Sprintf("  observed, unconfirmed: %d open %s in %d file(s) under observed/ (each waits for its owner; none is a requirement)", n, w, r.Observed["files"]))
	}
	for _, g := range r.Accepted {
		l = append(l, fmt.Sprintf("  accepted %s  (%s)", g.Key, g.Accepted))
	}
	if c := coverageLine(r.Coverage); c != "" {
		l = append(l, "  tests: "+c)
	}
	return strings.Join(l, "\n")
}

// coverageLine counts the requirements per recorded test state ("" when no result was recorded).
func coverageLine(cov map[string]trace.Coverage) string {
	n := trace.CoverageCounts(cov)
	if len(n) == 0 || n["not run"] == len(cov) {
		return ""
	}
	var parts []string
	for _, k := range []string{"passed", "failed", "skipped", "stale: spec changed", "stale: code changed", "not run"} {
		if n[k] > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n[k], k))
		}
	}
	return strings.Join(parts, ", ") + " (the last test results finish recorded)"
}

func gapObj(g trace.Gap) *Obj {
	return O("key", g.Key, "type", g.Type, "severity", If(!isErrGap(g), g.Severity), "accepted", If(g.Accepted != "", g.Accepted), "text", g.Text,
		"hint", If(g.Hint != "", g.Hint), "files", NonEmpty(g.Files), "line", If(g.Type == "over-anchored", g.Line), "fit", If(g.Fit != "", g.Fit), "removable", If(g.Removable, true))
}

// Drift reports the gaps between the living specs, the code anchors and the test tags (--text: a readable list).
func (e *Env) Drift() error {
	md := trace.Mode(e.Cfg)
	r := e.tr().Drift("", false)
	var errs, adv []any
	for _, g := range r.Open {
		if isErrGap(g) {
			errs = append(errs, gapObj(g))
		} else {
			adv = append(adv, gapObj(g))
		}
	}
	acc := []any{}
	for _, g := range r.Accepted {
		acc = append(acc, gapObj(g))
	}
	e.saySkipped()
	if e.O.Text {
		fmt.Fprintln(e.Out, driftText(r))
		if len(errs) > 0 {
			return quit(Fail)
		}
		return nil
	}
	next := "no drift"
	if len(errs) > 0 {
		next = "run /spec-garden: fix each gap by its hint, or accept the ones that belong to a requirement (`wingman-spec drift decide <key> --accept --note \"why\"`)"
	}
	var obs any = Skip
	if r.Observed["entries"] > 0 {
		obs = r.Observed
	}
	x := O("ok", len(errs) == 0, "mode", md, "requirements", r.Requirements, "counts", r.Counts, "observed", obs, "open", list(errs), "advisory", NonEmpty(adv),
		"notes", NonEmpty(r.Notes), "accepted", acc, "coverage", e.coverageObj(r.Coverage), "skipped", e.skippedObj(), "next", next)
	var fs []report.Finding
	for _, g := range r.Open {
		sev := "warning"
		if isErrGap(g) {
			sev = "error"
		}
		file := ""
		if len(g.Files) > 0 {
			file = g.Files[0]
		}
		fs = append(fs, report.Finding{Source: "drift", Code: g.Type, Severity: sev, Message: g.Text, File: file, Line: g.Line, Key: g.Key, Hint: g.Hint})
	}
	return e.writeReport("Drift", fs, x, len(errs) > 0)
}

// DriftDecide records an accepted gap (`Accepted:` on its requirement): one key, or --all <type>.
func (e *Env) DriftDecide() error {
	if !e.O.Accept {
		return die(Usage, "drift decide only records `--accept --note TEXT`: a gap you do not accept is fixed (the hint of each gap in `drift` says how)")
	}
	if e.O.All == "" && e.O.Key == "" {
		return die(Usage, "drift decide <gap-key> --accept --note TEXT   (gap keys: see `drift`); or --all <gap-type> --accept --note TEXT to accept every open gap of one type, e.g. --all unanchored-requirement")
	}
	if e.O.All != "" && !slices.Contains(trace.Acceptable, e.O.All) {
		return die(Usage, "only %s gaps can be accepted; a %s gap is fixed or removed (see its hint in `drift`)", strings.Join(trace.Acceptable, ", "), e.O.All)
	}
	tr := e.tr()
	rep := tr.Drift("", false)
	var gaps []trace.Gap
	if e.O.All != "" {
		for _, g := range rep.Open {
			if g.Type == e.O.All {
				gaps = append(gaps, g)
			}
		}
	} else {
		for _, g := range rep.Gaps {
			if g.Key == e.O.Key {
				gaps = append(gaps, g)
			}
		}
		if len(gaps) == 0 {
			return die(Usage, "no gap '%s' (keys look like unanchored-requirement:todo/add-a-todo; run `drift`)", e.O.Key)
		}
	}
	res, err := tr.Accept(gaps, e.O.Note)
	if err != nil {
		return die(Usage, "%v", err)
	}
	changed := 0
	unchanged := false
	for _, x := range res {
		if x.Changed {
			changed++
		} else {
			unchanged = true
		}
	}
	next := "commit the spec change; the gaps are listed as accepted"
	if unchanged && slices.ContainsFunc(gaps, func(g trace.Gap) bool { return g.Type == "stale-anchor" }) {
		next = "a stale-anchor clears when the requirement text changes in a commit: this line was already there with this reason; use a new reason"
	}
	e.print(O("accepted", list(res), "changed", changed, "next", next))
	return nil
}

// SyncReport is `sync --check`: specs merged, ADRs promoted and (traceability on) anchors and drift.
