package visual

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	selQuoteRE = regexp.MustCompile(`["'\s]+`)
	dismissRE  = regexp.MustCompile(`(?i)close|dismiss|cookie|consent|overlay|modal`)
	droppedRE  = regexp.MustCompile(`(?i)\b(omit\w*|no longer|dropped|not (?:shown|listed|displayed)|(?:has|shows) no (?:rows?|cards?|entry|entries)|no (?:rows?|cards?) for)\b`)
	plainRE    = regexp.MustCompile(`[^a-z0-9]+`)
)

// whenOf is a scenario's WHEN text, lower case, words only ("" when shorter than 5 words: too generic to compare).
func whenOf(s *Scenario) string {
	var w []string
	for _, t := range s.StepsText {
		if strings.Contains(t, "**WHEN**") || strings.Contains(t, "**GIVEN**") {
			w = append(w, strings.Fields(plainRE.ReplaceAllString(strings.ToLower(strings.ReplaceAll(t, "**WHEN**", "")), " "))...)
		}
	}
	if len(w) < 5 {
		return ""
	}
	return strings.Join(w, " ")
}

// dropsIt reports whether a scenario's THEN says the thing is omitted or no longer shown.
func dropsIt(s *Scenario) bool {
	for _, t := range s.StepsText {
		if !strings.Contains(t, "**WHEN**") && !strings.Contains(t, "**GIVEN**") && droppedRE.MatchString(t) {
			return true
		}
	}
	return false
}

func normSel(s string) string { return selQuoteRE.ReplaceAllString(s, "") }

// covers: absent selector a rules out sel when sel is a or a narrowing of it (a followed by [attr], .class, #id or :state).
func covers(a, sel string) bool {
	a, sel = normSel(a), normSel(sel)
	return sel == a || (strings.HasPrefix(sel, a) && strings.ContainsRune("[.:#", rune(sel[len(a)])))
}

// onLoad reports whether a state shows the page as it loads: its steps only wait, hover or dismiss an overlay.
func onLoad(st State) bool {
	for _, x := range st.Steps {
		if x.Op != "wait" && x.Op != "hover" && (x.Op != "click" || !dismissRE.MatchString(x.Target)) {
			return false
		}
	}
	return true
}

// loadAbsents are the absent: selectors of a block that hold on the page as it loads.
func loadAbsents(s *Scenario) []string {
	out := append([]string{}, s.Absents...)
	for _, st := range s.States {
		if onLoad(st) {
			out = append(out, st.Absents...)
		}
	}
	return out
}

// loadRequired are the key: and expect: selectors a block requires on the page as it loads.
func loadRequired(s *Scenario) []string {
	out := append([]string{}, s.Keys...)
	add := func(es []Expect) {
		for _, e := range es {
			out = append(out, e.Sel, e.Other)
		}
	}
	for _, e := range s.Expects {
		if e.State == nil || *e.State == "" {
			add([]Expect{e})
		}
	}
	for _, st := range s.States {
		if onLoad(st) {
			out = append(out, st.Keys...)
			add(st.Expects)
		}
	}
	return out
}

// page is the route and role a block loads: the path without a trailing slash, with its query (a query can name the data).
func page(s *Scenario) string {
	p, q, _ := strings.Cut(s.Route, "?")
	if q != "" {
		q = "?" + q
	}
	return routePath(p) + q + " as " + roleOf(s)
}

func roleOf(s *Scenario) string {
	if s.Role == "anonymous" {
		return ""
	}
	return s.Role
}

// StaleGuardLint (error, kind visual-stale-guard): a living scenario that stays in specs/ after archive (guards: the
// scenarios of the merged specs, less the change's own) requires on load, for the same route, query and role, a selector that
// one of the change's scenarios declares absent: there. Finish checks both, so one of them always fails: the planner
// has to MODIFY (rewrite or drop the scenario) or REMOVE the living requirement in the delta. Also (kind
// visual-dropped-scenario) a surviving living scenario of the same capability with the same WHEN as a change scenario
// whose THEN says the case is omitted or no longer shown: the change drops that behaviour, so its requirement goes.
func StaleGuardLint(own, guards []*Scenario, root string) []Problem {
	var out []Problem
	for _, g := range guards {
		if len(g.Errors) > 0 || g.RedirectsTo != "" {
			continue
		}
		done := false
		for _, d := range own {
			if w := whenOf(g); !done && len(d.Errors) == 0 && d.Capability == g.Capability && w != "" && w == whenOf(d) && dropsIt(d) {
				done = true
				out = append(out, problem(d, d.Line, "visual-dropped-scenario", "error", fmt.Sprintf("%s:%d: visual scenario %s says the case is dropped (%q), but %s (%s:%d, requirement %q) has the same WHEN and still checks the old behaviour after archive: put that requirement in this change's specs/%s.md under ## REMOVED (with a Reason) or under ## MODIFIED without that scenario; `Not visual` is only for behaviour that still exists", relTo(root, d.File), d.Line, d.ID, droppedRE.FindString(strings.Join(d.StepsText, " ")), g.ID, relTo(root, g.File), g.ScenarioLine, g.Requirement, g.Capability)))
			}
			if done || len(d.Errors) > 0 || page(d) != page(g) {
				continue
			}
			for _, a := range loadAbsents(d) {
				for _, sel := range loadRequired(g) {
					if sel == "" || done || !covers(a, sel) {
						continue
					}
					done = true
					out = append(out, problem(d, d.Line, "visual-stale-guard", "error", fmt.Sprintf("%s:%d: visual scenario %s says `absent: %s` on %s, but %s (%s:%d, requirement %q) still requires `%s` there, and finish checks both: put that requirement in this change's specs/%s.md under ## REMOVED (with a Reason) when the change drops that behaviour, or under ## MODIFIED with the scenario rewritten or dropped; `Not visual` is only for behaviour that still exists", relTo(root, d.File), d.Line, d.ID, a, d.Route, g.ID, relTo(root, g.File), g.ScenarioLine, g.Requirement, sel, g.Capability)))
				}
			}
		}
	}
	return out
}
