package visual

import (
	"strings"
	"testing"
)

func scen(t *testing.T, id, block, then string) *Scenario {
	t.Helper()
	text := "### Requirement: R\n\n#### Scenario: " + id + "\n- **WHEN** it opens\n- **THEN** " + then + "\n\n```visual\n" + block + "\n```\n"
	s := ParseSpec(text, "/specs/app.md", "app")
	if len(s) != 1 || len(s[0].Errors) > 0 {
		t.Fatalf("%s: bad block: %+v", id, s)
	}
	return s[0]
}

// A list view needs a state that shows it with data; non-list views and populated lists pass.
func TestDataStateLint(t *testing.T) {
	cases := []struct {
		name   string
		blocks []string
		want   string // "" = no finding, else a part of the text
	}{
		{"list, default state only", []string{"route: /orders\nkey: [data-testid=\"orders-list\"]"}, "no visual scenario of /orders shows it with data"},
		{"list, empty state only", []string{"route: /orders\nkey: [data-testid=\"orders-table\"]\nstate: empty\n  do: fill #q = zzz\n  key: [data-testid=\"orders-empty\"]"}, "states: empty"},
		{"no-rows is not populated", []string{"route: /orders\nkey: [data-testid=\"orders-grid\"]\nstate: no-rows\n  do: click #clear"}, "shows a list"},
		{"named but not reached", []string{"route: /orders\nkey: [data-testid=\"orders-list\"]\nstate: many-rows"}, "shows a list"},
		{"a table element", []string{"route: /orders\nkey: main table"}, "shows a list"},
		{"an ARIA grid", []string{"route: /orders\nkey: [role=\"grid\"]"}, "shows a list"},
		{"camelCase test id", []string{"route: /orders\nkey: [data-testid=\"orderRows\"]"}, "shows a list"},
		{"populated state", []string{"route: /orders\nkey: [data-testid=\"orders-list\"]\nstate: many-rows\n  key: [data-testid=\"order-row\"]"}, ""},
		{"one-row by steps", []string{"route: /orders\nkey: [data-testid=\"orders-list\"]\nstate: one-row\n  do: fill #q = Example\n  do: press Enter"}, ""},
		{"a role that names the data", []string{"route: /orders\nrole: buyer-with-orders\nkey: [data-testid=\"orders-list\"]"}, ""},
		{"a route query that names the data", []string{"route: /orders?fixture=many\nkey: [data-testid=\"orders-list\"]"}, ""},
		{"another scenario of the route covers it", []string{"route: /orders\nkey: [data-testid=\"orders-save\"]\nkey: [data-testid=\"orders-list\"]", "route: /orders/\nkey: [data-testid=\"orders-list\"]\nstate: long-name\n  do: fill #q = Long"}, ""},
		{"rows only at 1280 while 375 is checked", []string{"route: /orders\nviewports: 375\nkey: [data-testid=\"orders-form\"]\nkey: [data-testid=\"orders-list\"]", "route: /orders\nviewports: 1280\nkey: [data-testid=\"orders-list\"]\nstate: many-rows\n  key: [data-testid=\"order-row\"]"}, "all wider than 480px"},
		{"a form, no list", []string{"route: /profile\nkey: [data-testid=\"profile-name\"]\nkey: [data-testid=\"profile-save\"]"}, ""},
		{"navigation list", []string{"route: /\nkey: [data-testid=\"nav-list\"]\nkey: [data-testid=\"menu-items\"]\nkey: [role=\"tablist\"]"}, ""},
		{"layout classes are not read", []string{"route: /\nkey: .row\nkey: .grid > .card"}, ""},
		{"a form row", []string{"route: /\nkey: [data-testid=\"form-row\"]"}, ""},
		{"a redirect", []string{"route: /orders\nredirects-to: /login\nkey: [data-testid=\"orders-list\"]"}, ""},
	}
	for _, c := range cases {
		var ss []*Scenario
		for i, b := range c.blocks {
			ss = append(ss, scen(t, "s"+string(rune('a'+i)), b, "the page shows it"))
		}
		got := DataStateLint(ss, "/specs")
		switch {
		case c.want == "" && len(got) > 0:
			t.Errorf("%s: want no finding, got %v", c.name, got[0]["text"])
		case c.want != "" && (len(got) != 1 || !strings.Contains(got[0]["text"].(string), c.want) || got[0]["severity"] != "error"):
			t.Errorf("%s: want one error with %q, got %v", c.name, c.want, got)
		}
	}
}

// An ignore of the sideways scroll is a warning only when the scenario's own THEN rules it out.
func TestOverflowClaimLint(t *testing.T) {
	ig := "route: /\nkey: #a\nignore: layout:horizontal-overflow"
	for then, want := range map[string]bool{
		"nothing in `#main` scrolls sideways": true,
		"the page has no horizontal scroll":   true,
		"the table does not scroll sideways":  true,
		"the form is visible":                 false,
		"the wide table scrolls sideways":     false,
	} {
		if got := len(OverflowClaimLint([]*Scenario{scen(t, "x", ig, then)}, "/specs")) == 1; got != want {
			t.Errorf("THEN %q: warning %v, want %v", then, got, want)
		}
	}
	if n := len(OverflowClaimLint([]*Scenario{scen(t, "x", "route: /\nkey: #a", "nothing scrolls sideways")}, "/specs")); n != 0 {
		t.Errorf("no ignore: want no warning, got %d", n)
	}
}
