package visual

import (
	"strings"
	"testing"
)

// A living scenario that still requires on load what the change declares absent on the same page is an error; other
// pages, roles, queries, states reached by steps and unrelated selectors are not.
func TestStaleGuardLint(t *testing.T) {
	own := "route: /favorites\nrole: customer\nkey: [data-testid=\"favorites-list\"]\nabsent: [data-testid='favorite-add'][disabled]\nabsent: input.quantity"
	cases := []struct {
		name, own, guard, want string // want "" = no finding
	}{
		{"same selector, other quotes", own, "route: /favorites/\nrole: customer\nkey: [data-testid=\"favorite-add\"][disabled]", "still requires `[data-testid=\"favorite-add\"][disabled]`"},
		{"a narrowing of the absent selector", own, "route: /favorites\nrole: customer\nkey: input.quantity[disabled]", "still requires `input.quantity[disabled]`"},
		{"an expect selector", own, "route: /favorites\nrole: customer\nkey: main\nexpect: input.quantity width ~ 40px", "input.quantity"},
		{"a state that only dismisses a modal", own, "route: /favorites\nrole: customer\nstate: unavailable\n  do: wait 400\n  do: click button.modal-close\n  key: input.quantity[disabled]", "input.quantity[disabled]"},
		{"a state reached by steps", own, "route: /favorites\nrole: customer\nstate: after-add\n  do: click [data-testid=\"add-sample\"]\n  key: input.quantity", ""},
		{"another page", own, "route: /cart\nrole: customer\nkey: input.quantity", ""},
		{"another role", own, "route: /favorites\nkey: input.quantity", ""},
		{"another query", strings.Replace(own, "/favorites", "/favorites?fixture=empty", 1), "route: /favorites?fixture=many\nrole: customer\nkey: input.quantity", ""},
		{"a selector that only shares a prefix", own, "route: /favorites\nrole: customer\nkey: input.quantity-label", ""},
		{"no absent in the change", "route: /favorites\nrole: customer\nkey: [data-testid=\"favorites-list\"]", "route: /favorites\nrole: customer\nkey: input.quantity", ""},
	}
	for _, c := range cases {
		o := scen(t, "own", c.own, "it shows")
		g := scen(t, "old", c.guard, "it shows")
		got := StaleGuardLint([]*Scenario{o}, []*Scenario{g}, "/")
		switch {
		case c.want == "" && len(got) > 0:
			t.Errorf("%s: unexpected %v", c.name, got)
		case c.want != "" && (len(got) != 1 || !strings.Contains(got[0]["text"].(string), c.want) || got[0]["kind"] != "visual-stale-guard"):
			t.Errorf("%s: want one finding with %q, got %v", c.name, c.want, got)
		}
	}
}

// A living scenario with the same WHEN as a change scenario that says the case is dropped is an error; a different
// WHEN, a too generic WHEN, a THEN that keeps the case or another capability is not.
func TestDroppedScenarioLint(t *testing.T) {
	mk := func(capability, when, then string) *Scenario {
		s := ParseSpec("### Requirement: R\n\n#### Scenario: S\n- **WHEN** "+when+"\n- **THEN** "+then+"\n\n```visual\nroute: /favorites\nkey: main\n```\n", "/specs/"+capability+".md", capability)
		return s[0]
	}
	when := "the shopper has item `42` saved and no warehouse has it in stock"
	old := mk("favorites", when, "the row shows a disabled quantity")
	cases := []struct {
		name string
		own  *Scenario
		want bool
	}{
		{"same WHEN, omitted", mk("favorites", when, "`/favorites` has no row for item `42`"), true},
		{"same WHEN, the item is omitted", mk("favorites", strings.ToUpper(when[:1])+when[1:]+".", "item `42` is omitted from the list"), true},
		{"same WHEN, the case still shows", mk("favorites", when, "the row shows `Out of stock`"), false},
		{"another WHEN", mk("favorites", "the shopper has item `42` saved and it is in stock", "item `42` is omitted"), false},
		{"a generic WHEN", mk("favorites", "the page opens", "it has no rows"), false},
		{"another capability", mk("cart", when, "item `42` is omitted"), false},
	}
	for _, c := range cases {
		g := old
		if c.name == "a generic WHEN" {
			g = mk("favorites", "the page opens", "it shows the list")
		}
		got := StaleGuardLint([]*Scenario{c.own}, []*Scenario{g}, "/")
		if hit := len(got) == 1 && got[0]["kind"] == "visual-dropped-scenario" && strings.Contains(got[0]["text"].(string), "## REMOVED"); hit != c.want || (!c.want && len(got) > 0) {
			t.Errorf("%s: want %v, got %v", c.name, c.want, got)
		}
	}
}
