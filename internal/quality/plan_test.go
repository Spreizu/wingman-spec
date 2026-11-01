package quality

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestSerialGroupWarning(t *testing.T) {
	kinds := func(text string) int {
		n := 0
		for _, f := range PlanLint(text, PlanOpts{Size: "M"}).Problems {
			if f.Kind == "parallel" {
				n++
			}
		}
		return n
	}
	serial := "## 1. G\n- [ ] 1.1 a\n  - Files: src/x.js, src/a.js\n- [ ] 1.2 b\n  - Files: src/x.js\n- [ ] 1.3 c\n  - Files: src/b.js\n  - After: 1.1, 1.2\n"
	if kinds(serial) != 1 {
		t.Errorf("a group whose tasks all share files or wait for each other: want one parallel warning")
	}
	free := "## 1. G\n- [ ] 1.1 a\n  - Files: src/x.js\n- [ ] 1.2 b\n  - Files: src/x.js\n- [ ] 1.3 c\n  - Files: src/b.js\n"
	if kinds(free) != 0 {
		t.Errorf("1.3 can run beside 1.1: want no parallel warning")
	}
}

// Task labels are unique, After: names an earlier task, and every implementation task lists its Files.
func TestIDLint(t *testing.T) {
	kinds := func(text string) []string {
		var out []string
		for _, f := range PlanLint(text, PlanOpts{Size: "M"}).Problems {
			if f.Severity == "error" && strings.HasPrefix(f.Kind, "task-") {
				out = append(out, fmt.Sprintf("%s@%d", f.Kind, f.Line))
			}
		}
		return out
	}
	cases := []struct {
		name, plan string
		want       []string
	}{
		{"clean", "## 1. G\n- [ ] 1.1 a\n  - Files: a.js\n- [ ] 1.2 b\n  - Files: b.js\n  - After: 1.1\n", nil},
		{"duplicate label", "## 1. G\n- [ ] 1.1 a\n  - Files: a.js\n- [ ] 1.1 b\n  - Files: b.js\n", []string{"task-id@4"}},
		{"After: itself", "## 1. G\n- [ ] 1.1 a\n  - Files: a.js\n  - After: 1.1\n", []string{"task-after@2"}},
		{"After: unknown", "## 1. G\n- [ ] 1.1 a\n  - Files: a.js\n  - After: 9.9\n", []string{"task-after@2"}},
		{"After: a later task", "## 1. G\n- [ ] 1.1 a\n  - Files: a.js\n  - After: 1.2\n- [ ] 1.2 b\n  - Files: b.js\n", []string{"task-after@2"}},
		{"no Files", "## 1. G\n- [ ] 1.1 a\n  - Done when: `true` exits 0\n", []string{"task-files@2"}},
	}
	for _, c := range cases {
		if got := kinds(c.plan); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	noFiles := "## 1. G\n- [ ] 1.1 a\n  - Done when: `true` exits 0\n"
	for mode, want := range map[string]string{"warn": "warning", "off": ""} {
		got := ""
		for _, f := range PlanLint(noFiles, PlanOpts{Size: "M", Files: mode}).Problems {
			if f.Kind == "task-files" {
				got = f.Severity
			}
		}
		if got != want {
			t.Errorf("traceability %s: the Files: rule is %q, want %q", mode, got, want)
		}
	}
}
