package quality

import "testing"

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
