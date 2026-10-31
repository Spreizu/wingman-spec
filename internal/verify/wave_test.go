package verify

import (
	"testing"

	"github.com/Spreizu/wingman-spec/internal/tasks"
)

func TestOwns(t *testing.T) {
	cases := []struct {
		entry, file string
		want        bool
	}{
		{"src/a.js", "src/a.js", true},
		{"./src/a.js", "src/a.js", true},
		{"src/a.js", "src/a.jsx", false},
		{"src/", "src/deep/a.js", true},
		{"src/", "lib/src/a.js", false},
		{"src/*.js", "src/a.js", true},
		{"src/*.js", "src/deep/a.js", false},
		{"src/**", "src/deep/a.js", true},
		{"src/**/*.test.js", "src/deep/a.test.js", true},
		{"src/**/*.test.js", "src/deep/a.js", false},
		{"lib/**", "src/a.js", false},
	}
	for _, c := range cases {
		if got := owns(c.entry, c.file); got != c.want {
			t.Errorf("owns(%q, %q) = %v, want %v", c.entry, c.file, got, c.want)
		}
	}
}

func TestOverlap(t *testing.T) {
	tree := []string{"src/a.js", "src/b.js", "lib/c.js"}
	cases := []struct {
		a, b []string
		want string
	}{
		{[]string{"src/a.js"}, []string{"src/b.js"}, ""},
		{[]string{"src/a.js"}, []string{"src/a.js", "lib/c.js"}, "src/a.js"},
		{[]string{"src/"}, []string{"src/b.js"}, "src/b.js"},
		{[]string{"src/*.js"}, []string{"src/**"}, "src/*.js"}, // the glob itself is the shared entry
		{[]string{"src/*.js"}, []string{"lib/*.js"}, ""},
	}
	for _, c := range cases {
		if got := overlap(c.a, c.b, tree); got != c.want {
			t.Errorf("overlap(%q, %q) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestLaneable(t *testing.T) {
	plan := tasks.Parse("## 1. G\n- [ ] 1.1 a\n  - Files: src/a.js\n- [ ] 1.2 deps\n  - Files: src/b.js, package.json\n- [ ] 1.3 none\n- [ ] 1.R Review the group\n  - Files: src/a.js\n- [ ] 1.4 db\n  - Files: db/migrations/001.sql\n")
	want := map[string]bool{"1.1": true, "1.2": false, "1.3": false, "1.R": false, "1.4": false}
	for _, tk := range plan.Groups[0].Tasks {
		if got := laneable(tk); got != want[tk.Label] {
			t.Errorf("laneable(%s) = %v, want %v", tk.Label, got, want[tk.Label])
		}
	}
}

func TestAttribute(t *testing.T) {
	w := &Wave{Lanes: []*Lane{
		{Task: TaskState{Member: Member{Label: "1.1", Details: []string{"Files: src/a.js"}}}},
		{Task: TaskState{Member: Member{Label: "1.2", Details: []string{"Files: src/b.js"}}}},
		{Task: TaskState{Member: Member{Label: "1.3", Details: []string{"Files: src/*.js"}}}},
	}}
	got := func(text string) []string {
		var out []string
		for _, l := range attribute(w, text) {
			out = append(out, l.Task.Label)
		}
		return out
	}
	if g := got("FAIL src/b.js:3:1 expected 2"); len(g) != 1 || g[0] != "1.2" {
		t.Errorf("a failure naming src/b.js: %v", g)
	}
	if g := got("error in src/a.jsx and lib/src/b.js"); len(g) != 0 {
		t.Errorf("a longer path is not the lane's file: %v", g)
	}
	if g := got("see src/a.js."); len(g) != 1 {
		t.Errorf("a path at the end of a sentence: %v", g)
	}
}
