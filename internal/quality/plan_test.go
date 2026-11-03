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

func TestSizeCapsXLAndSplit(t *testing.T) {
	plan := func(n int) string {
		var b strings.Builder
		b.WriteString("## 1. G\n\n")
		for i := 1; i <= n; i++ {
			fmt.Fprintf(&b, "- [ ] 1.%d T%d\n  - Spec: a > b\n  - Test first: t\n  - Files: src/f%d.ts\n  - Done when: `npm test` exits 0\n", i, i, i)
		}
		b.WriteString("- [ ] 1.R Request code review of the whole change\n")
		return b.String()
	}
	kinds := func(size string, n int) map[string]string {
		out := map[string]string{}
		for _, f := range PlanLint(plan(n), PlanOpts{Size: size}).Problems {
			if strings.HasPrefix(f.Kind, "size") {
				out[f.Kind] = f.Severity + ": " + f.Text
			}
		}
		return out
	}
	if k := kinds("L", 13); !strings.Contains(k["size-cap"], "error") || !strings.Contains(k["size-cap"], "Set Size: XL") || strings.Contains(strings.ToLower(k["size-cap"]), "merge") {
		t.Fatalf("L with 13 tasks: %v", k)
	}
	if k := kinds("XL", 13); len(k) != 0 {
		t.Fatalf("XL with 13 tasks: %v", k)
	}
	if k := kinds("S", 7); !strings.Contains(k["size-cap"], "Set Size: L") {
		t.Fatalf("S with 7 tasks: %v", k)
	}
	k := kinds("XXL", 31)
	if _, bad := k["size-cap"]; bad || !strings.HasPrefix(k["size-split"], "warning") || !strings.Contains(k["size-split"], "separate changes") {
		t.Fatalf("XXL with 31 tasks: %v", k)
	}
	if got := ReadProposalSize("Size: XL\nRisk: none\n").Size; got != "XL" {
		t.Fatalf("Size: XL read as %q", got)
	}
	if !IsLarge("XXL") || IsLarge("M") || IsLarge("") || SizeFor(21) != "XXL" || SizeFor(31) != "XXL" || SizeFor(4) != "M" {
		t.Fatal("IsLarge/SizeFor")
	}
}
