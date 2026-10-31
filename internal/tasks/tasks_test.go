package tasks

import (
	"slices"
	"testing"
)

const plan = "Size: M\n\n## 1. Skeleton (risky)\n\n- [ ] 1.1 Build the list <!-- note -->\n  - Spec: items > List (all scenarios)\n" +
	"  - Files: `src/list.ts`, src/list.test.ts\n  - Done when: `npm test -- list` exits 0\n- [x] 1.2 Style it\n  - After: 1.1\n" +
	"- [ ] 1.R Request code review for group 1\n\n## 2. More\n\n```\n- [ ] 9.9 fenced\n```\n- [ ] 2.1 Request code review of the whole change\n"

func TestParse(t *testing.T) {
	p := Parse(plan)
	if p.Size != "M" || len(p.Groups) != 2 {
		t.Fatalf("size %q, groups %d", p.Size, len(p.Groups))
	}
	g := p.Groups[0]
	if !g.Risky || g.N != "1" || g.Title != "Skeleton (risky)" || len(g.Tasks) != 3 {
		t.Fatalf("group 1 = %+v", g)
	}
	t1 := g.Tasks[0]
	if t1.Title != "Build the list" || !slices.Equal(t1.Files, []string{"src/list.ts", "src/list.test.ts"}) {
		t.Errorf("task 1.1 = %+v", t1)
	}
	if line, cmd := t1.DoneWhen(); cmd != "npm test -- list" || line == "" {
		t.Errorf("DoneWhen = %q %q", line, cmd)
	}
	if !g.Tasks[1].Done || !slices.Equal(g.Tasks[1].After(), []string{"1.1"}) {
		t.Errorf("task 1.2 = %+v", g.Tasks[1])
	}
	if !g.Tasks[2].Review || g.Tasks[2].Final {
		t.Errorf("1.R review/final = %v/%v", g.Tasks[2].Review, g.Tasks[2].Final)
	}
	last := p.Groups[1].Tasks
	if len(last) != 1 || !last[0].Final {
		t.Errorf("group 2 tasks = %+v", last)
	}
	if len(p.All()) != 4 {
		t.Errorf("All = %d", len(p.All()))
	}
}

func TestAmbiguousLines(t *testing.T) {
	got := AmbiguousLines("- [ ] 1.1 a\n  - [ ] nested\n```\n- [ ] fenced\n```\n")
	if len(got) != 2 || got[0].Kind != "nested" || got[1].Kind != "fenced" || got[1].Line != 4 {
		t.Fatalf("got %+v", got)
	}
}
