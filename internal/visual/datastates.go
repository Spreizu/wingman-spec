package visual

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// A view of variable data (a list, table, grid, feed, cart or results) is recognised by its selectors only: a
// data-testid, id or ARIA role whose words name a collection, or a table/tbody/tr element. Classes are not read (`.row`
// and `.grid` are layout helpers), and navigation, menus, tabs and form layout are excluded. Scenarios are grouped by
// route: one scenario of the view with a populated state covers the others (a form scenario on the same page).
var (
	selNameRE     = regexp.MustCompile(`data-testid\s*[~|^$*]?=\s*["']?([\w-]+)|#([\w-]+)|\[role\s*=\s*["']?([\w-]+)`)
	selTagRE      = regexp.MustCompile(`(?:^|[\s>+~,(])(table|tbody|tr)(?:$|[\s>+~,.#\[:)])`)
	camelRE       = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	wordSplitRE   = regexp.MustCompile(`[^a-z0-9]+`)
	collection    = words("list lists table tables row rows grid feed results items entries cart basket rowgroup treegrid")
	notCollection = words("nav navigation menu menubar tab tabs tablist breadcrumb breadcrumbs toolbar option options dropdown select listbox combobox stepper steps legend footer header sidebar form layout")
	// a state or role named for data that is there (one-row, many-rows, long-name, each-status, with-orders) ...
	populated = words("with one single few two three several many multiple filled populated full row rows item items entry entries long longer longest overflow overflowing scroll paged paginated mixed each every status statuses variant variants")
	// ... and not for data that is missing (no-rows, empty, error)
	unpopulated = words("empty zero none no nothing blank missing cleared error errors failed failure loading offline")
	// a THEN line saying the page does not scroll sideways
	noSidewaysRE = regexp.MustCompile(`(?i)\bno(?:thing)?\b[^.;]*?\bscroll\w*\s+(?:sideways|horizontally)|\bno\s+(?:horizontal|sideways)\s+(?:scroll\w*|overflow)|\b(?:not|never|n't)\s+scroll\w*\s+(?:sideways|horizontally)|\bwithout\s+(?:horizontal|sideways)\s+scroll`)
)

func words(s string) map[string]bool {
	out := map[string]bool{}
	for x := range strings.FieldsSeq(s) {
		out[x] = true
	}
	return out
}

func tokens(s string) []string {
	return wordSplitRE.Split(strings.ToLower(camelRE.ReplaceAllString(s, "$1-$2")), -1)
}

// collectionSelector is the first selector of s (keys, state keys, expects) that names a list-like element, or "".
func collectionSelector(s *Scenario) string {
	sels := s.AllKeys()
	for _, x := range s.Expects {
		sels = append(sels, x.Selectors()...)
	}
	for _, sel := range sels {
		if selTagRE.MatchString(sel) {
			return sel
		}
		for _, m := range selNameRE.FindAllStringSubmatch(sel, -1) {
			ts := tokens(m[1] + m[2] + m[3])
			if slices.ContainsFunc(ts, func(t string) bool { return collection[t] }) && !slices.ContainsFunc(ts, func(t string) bool { return notCollection[t] }) {
				return sel
			}
		}
	}
	return ""
}

func namesPopulated(name string) bool {
	ts := tokens(name)
	return slices.ContainsFunc(ts, func(t string) bool { return populated[t] }) && !slices.ContainsFunc(ts, func(t string) bool { return unpopulated[t] })
}

// populatedStates are the states of s that show the view with data: named for it and reached (steps or a key of their
// own), or every state when the role or the route's query names the data (a seeded test account, ?fixture=many).
func populatedStates(s *Scenario) []string {
	_, query, _ := strings.Cut(s.Route, "?")
	var out []string
	for _, st := range s.States {
		if namesPopulated(s.Role) || namesPopulated(query) || (namesPopulated(st.Name) && (len(st.Steps) > 0 || len(st.Keys) > 0)) {
			out = append(out, st.Name)
		}
	}
	return out
}

func routePath(r string) string {
	p, _, _ := strings.Cut(r, "?")
	p, _, _ = strings.Cut(p, "#")
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	return p
}

func narrow(vps []int) bool { return slices.ContainsFunc(vps, func(w int) bool { return w <= 480 }) }

// DataStateLint (error, kind visual-data-states): a view of variable data whose visual scenarios check it only as the
// live app happens to load it, or only empty, so a layout that breaks once rows exist passes. Its route needs a state
// named for a populated case (one-row, many-rows, long-name, each-status) with steps or a row key, or a role or route
// query that names the data; when the view is checked at a narrow width, a populated state there too.
func DataStateLint(scens []*Scenario, root string) []Problem {
	var out []Problem
	var routes []string
	group := map[string][]*Scenario{}
	for _, s := range scens {
		if len(s.Errors) > 0 || s.RedirectsTo != "" {
			continue
		}
		r := routePath(s.Route)
		if group[r] == nil {
			routes = append(routes, r)
		}
		group[r] = append(group[r], s)
	}
	for _, r := range routes {
		var list *Scenario
		sel := ""
		for _, s := range group[r] {
			if sel = collectionSelector(s); sel != "" {
				list = s
				break
			}
		}
		if list == nil {
			continue
		}
		var wide, small []string
		narrowChecked := false
		for _, s := range group[r] {
			narrowChecked = narrowChecked || narrow(s.Viewports)
			for _, st := range populatedStates(s) {
				if narrow(s.Viewports) {
					small = append(small, s.ID+" "+st)
				} else {
					wide = append(wide, s.ID+" "+st)
				}
			}
		}
		how := "Add a `state:` per data state the change affects, named for it (`state: one-row`, `state: many-rows`, `state: long-name`, `state: each-status`), with an indented `key:` on a row, reached by `do:` steps, seed data or a test role that the design's Testing approach names"
		var why string
		switch {
		case len(wide)+len(small) == 0:
			var names []string
			for _, s := range group[r] {
				for _, st := range s.States {
					if !slices.Contains(names, st.Name) {
						names = append(names, st.Name)
					}
				}
			}
			why = fmt.Sprintf("no visual scenario of %s shows it with data (states: %s), so the check sees only what the database holds or the empty list", r, strings.Join(names, ", "))
		case narrowChecked && len(small) == 0:
			why = fmt.Sprintf("%s is checked at a narrow width, but only %s show it with data, all wider than 480px", r, strings.Join(wide, ", "))
			how = "Check a populated state at 375 too (`viewports: 375` on a scenario with that state)"
		default:
			continue
		}
		out = append(out, problem(list, list.Line, "visual-data-states", "error", fmt.Sprintf("%s:%d: visual scenario %s shows a list (%s), but %s. %s; `Not visual` cannot replace it", relTo(root, list.File), list.Line, list.ID, sel, why, how)))
	}
	return out
}

// OverflowClaimLint (warning, kind visual-overflow-claim): a block that skips layout:horizontal-overflow while its own
// THEN says nothing scrolls sideways, so the check can no longer see the claim fail.
func OverflowClaimLint(scens []*Scenario, root string) []Problem {
	var out []Problem
	for _, s := range scens {
		if !slices.Contains(s.Ignores, "layout:horizontal-overflow") {
			continue
		}
		for _, t := range s.StepsText {
			if strings.Contains(t, "**WHEN**") || strings.Contains(t, "**GIVEN**") || !noSidewaysRE.MatchString(t) {
				continue
			}
			out = append(out, problem(s, s.Line, "visual-overflow-claim", "warning", fmt.Sprintf("%s:%d: visual scenario %s says %q but has `ignore: layout:horizontal-overflow`, which hides exactly that defect: drop the ignore, or reword the THEN if sideways scrolling is accepted", relTo(root, s.File), s.Line, s.ID, noSidewaysRE.FindString(t))))
			break
		}
	}
	return out
}
