package trace

import (
	"fmt"
	"slices"
)

// SyncReport says whether a change is fully synced: specs merged, ADRs promoted and, with traceability on, its
// requirements anchored and no drift it caused.
type SyncReport struct {
	OK       bool              `json:"ok"`
	Problems []string          `json:"problems"`
	Warnings []string          `json:"warnings"`
	Parts    map[string]string `json:"parts"`
}

// SyncCheck adds the anchors, drift and Why parts to base (the specs and adrs problems of change.SyncCheck). Read-only.
func (c Ctx) SyncCheck(changeDir string, base []string) SyncReport {
	rep := SyncReport{Problems: append([]string{}, base...), Warnings: []string{}, Parts: map[string]string{}}
	specsMerged, adrsOK := true, true
	for _, p := range base {
		if len(p) >= 6 && p[:6] == "specs:" {
			specsMerged = false
		} else {
			adrsOK = false
		}
	}
	rep.Parts["specs"] = map[bool]string{true: "merged", false: "not merged"}[specsMerged]
	rep.Parts["adrs"] = map[bool]string{true: "promoted", false: "not promoted"}[adrsOK]
	md := Mode(c.Cfg)
	switch {
	case md == "off":
	case IsSpecOnly(changeDir):
		rep.Parts["anchors"] = "skipped (spec-only change: requirements not built yet are the drift backlog)"
		rep.Parts["drift"] = rep.Parts["anchors"]
	case !specsMerged:
		rep.Parts["anchors"] = "skipped (specs not merged yet)"
		rep.Parts["drift"] = rep.Parts["anchors"]
	default:
		al := c.AnchorLint(changeDir)
		live := c.Drift(changeDir, true)
		rep.Parts["anchors"] = "ok"
		if len(al.Problems) > 0 {
			rep.Parts["anchors"] = "problems"
		}
		var sev []string
		for _, p := range al.Problems {
			if p.Severity == "error" {
				sev = append(sev, "anchors: "+p.Text)
			}
		}
		n, legacy := 0, 0
		for _, g := range live.Open {
			mine := slices.Contains(al.Mine, g.Subject)
			switch g.Type {
			case "orphan-anchor", "stale-test-tag", "unsynced-archive":
			case "unanchored-requirement", "untested-requirement":
				if !mine {
					legacy++
					continue
				}
			default:
				continue
			}
			n++
			sev = append(sev, "drift: "+g.Key+": "+g.Text)
		}
		rep.Parts["drift"] = "clean"
		if n > 0 {
			rep.Parts["drift"] = fmt.Sprintf("%d open gap(s)", n)
		}
		for _, p := range c.WhyLint(changeDir).Problems {
			if p.Severity == "error" {
				sev = append(sev, "why: "+p.Text)
			}
		}
		if md == "warn" {
			rep.Warnings = append(rep.Warnings, sev...)
		} else {
			rep.Problems = append(rep.Problems, sev...)
		}
		if legacy > 0 {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("drift: %d other requirement(s) have no code/test anchor (run `wingman-spec drift`; /spec-garden fixes or accepts each gap)", legacy))
		}
	}
	rep.OK = len(rep.Problems) == 0
	return rep
}
