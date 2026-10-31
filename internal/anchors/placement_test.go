package anchors

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func placementKinds(text string, isTest bool) string {
	var ks []string
	for _, f := range Placement(text, isTest) {
		if !slices.Contains(ks, f.Kind) {
			ks = append(ks, f.Kind)
		}
	}
	slices.Sort(ks)
	return strings.Join(ks, " ")
}

// Good fixtures give no finding; bad fixtures give every kind, in ts, js, py, go, java, vue and php.
func TestPlacementFixtures(t *testing.T) {
	fix := filepath.Join("..", "..", "tests", "fixtures", "placement")
	read := func(n string) string {
		b, err := os.ReadFile(filepath.Join(fix, n))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	for _, f := range []string{"good.ts", "good.js", "good.py", "good.go", "Good.java", "good.vue", "good.php"} {
		if got := placementKinds(read(f), strings.Contains(f, ".test.")); got != "" {
			t.Errorf("%s: want no finding, got %q", f, got)
		}
	}
	for _, f := range []string{"bad.ts", "bad.js", "bad.py", "bad.go", "Bad.java", "bad.vue", "bad.php"} {
		want := "detached-marker duplicate-marker file-top-marker trailing-marker"
		if f == "bad.vue" { // the template comment is attached to <script>
			want = "detached-marker duplicate-marker trailing-marker"
		}
		if got := placementKinds(read(f), false); got != want {
			t.Errorf("%s: want %q, got %q", f, want, got)
		}
	}
}

func TestPlacementEdgeCases(t *testing.T) {
	at := func(text string, isTest bool) string {
		var out []string
		for _, f := range Placement(text, isTest) {
			out = append(out, f.Kind+":"+strconv.Itoa(f.Line))
		}
		return strings.Join(out, " ")
	}
	cases := []struct {
		name, text string
		isTest     bool
		want       string
	}{
		{"a test file may carry one marker at the top", "// @spec a/b\nimport x from \"y\";\nit(\"one\", () => {});\nit(\"two\", () => {});\n", true, ""},
		{"the same marker in the doc comment and in another function is fine", "/** @spec a/b */\nfunction one() {\n  return 1;\n}\n\n/** @spec a/b */\nfunction two() {\n  return 2;\n}\n", false, ""},
		{"two requirements in one function, each marked once", "function f() {\n  // @spec a/b\n  x();\n  // @spec a/c\n  y();\n}\n", false, ""},
		{"a marker listing several keys is not a duplicate of itself", "/** @spec a/b, a/c */\nfunction f() {}\n", false, ""},
		{"the same key twice in one function is reported on the second line", "function f() {\n  // @spec a/b\n  x();\n  // @spec a/b\n  y();\n}\n", false, "duplicate-marker:4"},
		{"an end-of-line marker is reported", "function f() {\n  x(); // @spec a/b\n}\n", false, "trailing-marker:2"},
		{"a marker before a closing brace is detached", "function f() {\n  x();\n  // @spec a/b\n}\n", false, "detached-marker:3"},
		{"a marker followed by a decorator then the function is attached", "# @spec a/b\n@decorator\ndef f():\n    pass\n", false, ""},
	}
	for _, c := range cases {
		if got := at(c.text, c.isTest); got != c.want {
			t.Errorf("%s: want %q, got %q", c.name, c.want, got)
		}
	}
}
