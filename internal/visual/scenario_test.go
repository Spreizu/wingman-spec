package visual

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// normalize drops null, "", false and empty values the two parsers may write differently, decodes to plain values, and
// writes a "file" path with forward slashes (the parser returns the platform's path).
func normalize(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	var walk func(any) any
	walk = func(x any) any {
		switch y := x.(type) {
		case map[string]any:
			out := map[string]any{}
			for k, v := range y {
				if v == nil || v == "" || v == false {
					continue
				}
				if f, ok := v.(string); ok && k == "file" {
					v = filepath.ToSlash(f)
				}
				out[k] = walk(v)
			}
			return out
		case []any:
			for i := range y {
				y[i] = walk(y[i])
			}
		}
		return x
	}
	return walk(v)
}

// TestParseFixture: every field, step, expect, reference and error of the fixture parses as recorded in testdata/parity.json
// (written by the 0.11 JavaScript parser this one replaced).
func TestParseFixture(t *testing.T) {
	want, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(ParseScenarios("testdata/parity"))
	if w, g := normalize(t, want), normalize(t, got); !reflect.DeepEqual(w, g) {
		gi, _ := json.MarshalIndent(g, "", " ")
		t.Fatalf("parse differs from testdata/parity.json:\n%s", gi)
	}
}

// block parses a visual block body after the given leading lines.
func block(lead []string, text string) *Scenario {
	return parseBlock(append(lead, strings.Split(text, "\n")...), 1)
}

// errs joins the block's errors for substring checks.
func errs(s *Scenario) string { return strings.Join(s.Errors, "\n") }

func TestIgnoreGrammar(t *testing.T) {
	lead := []string{"route: /", "key: [a]"}
	s := block(lead, "ignore: a11y:color-contrast\nignore: runtime:console-error\nignore: content:   # page chrome\nignore-http: /static/images/\nignore-http: /ads/")
	if len(s.Errors) != 0 || !reflect.DeepEqual(s.Ignores, []string{"a11y:color-contrast", "runtime:console-error", "content:"}) || !reflect.DeepEqual(s.IgnoreHTTP, []string{"/static/images/", "/ads/"}) {
		t.Fatalf("every form: %+v %v %v", s.Errors, s.Ignores, s.IgnoreHTTP)
	}
	for _, v := range []string{"a11y:", "runtime:", "layout:horizontal-overflow", "a11y:image-alt", "runtime:http-error", "content:broken-image"} {
		if e := errs(block(lead, "ignore: "+v)); e != "" {
			t.Errorf("ignore: %s refused: %s", v, e)
		}
	}
	for _, v := range []string{"layout:key-missing", "layout:key-hidden", "layout:key-offscreen", "layout:overlap", "design:expect-failed", "design:expect-unmatched", "role:forbidden-visible", "role:no-redirect", "role:login-failed", "state:step-failed", "server:not-ready", "regression:aria-changed", "layout:", "design:", "role:"} {
		if e := errs(block(lead, "ignore: "+v)); !strings.Contains(e, "is refused") {
			t.Errorf("ignore: %s not refused: %q", v, e)
		}
	}
	for in, want := range map[string]string{
		"ignore:":                      "empty ignore value",
		"ignore: :":                    "matches nothing useful",
		"ignore-http:":                 "empty ignore-http",
		"ignore: runtime:consol-error": "not a known defect code",
		"ignore: nonsense":             "not a known defect code",
		"ignore: a11y:*":               "no spaces, commas or wildcards",
		"ignore: a11y:, runtime:":      "no spaces, commas or wildcards",
		"ignore-http: /":               "too broad",
		"ignore-http: ab":              "too broad",
		"ignore-http: https://":        "too broad",
		"ignore-http: ...":             "too broad",
		"state: a\n  ignore: a11y:":    "belongs to the whole block",
		"bogus: 1":                     "ignore, ignore-http",
	} {
		if e := errs(block(lead, in)); !strings.Contains(e, want) {
			t.Errorf("%q: want %q in %q", in, want, e)
		}
	}
}

func TestStepGrammar(t *testing.T) {
	lead := []string{"route: /", "key: [a]", "state: s"}
	steps := func(text string) []Step { return block(lead, text).States[0].Steps }
	if st := steps("  do: click! .save\n  do: hover! .menu"); len(st) != 2 || st[0] != (Step{Op: "click", Target: ".save", Strict: true}) || !st[1].Strict {
		t.Errorf("click! and hover! are strict steps: %+v", st)
	}
	if st := steps("  do: click .save"); len(st) != 1 || st[0].Strict {
		t.Errorf("plain click is not strict: %+v", st)
	}
	for _, op := range []string{"fill", "press", "storage", "goto", "wait"} {
		if e := errs(block(lead, "  do: "+op+"! .x = 1")); !strings.Contains(e, "click!") || !strings.Contains(e, "hover!") || !strings.Contains(e, "can be strict") {
			t.Errorf("%s! is not refused: %q", op, e)
		}
	}
	if len(block(lead, "  viewports: 375").Errors) == 0 {
		t.Error("a state has no viewports: of its own")
	}
}

func TestRoleGrammar(t *testing.T) {
	s := block(nil, "route: /\nrole: admin\nkey: [a]\nstate: s\n  do: click [b]\n  absent: [c]\nabsent: [d]\nredirects-to: /x/")
	if len(s.Errors) != 0 || s.Role != "admin" || s.Absents[0] != "[d]" || s.States[0].Absents[0] != "[c]" || s.RedirectsTo != "/x/" {
		t.Fatalf("role:, absent: and redirects-to: %+v", s)
	}
}

func TestRubricProblems(t *testing.T) {
	ok := "RUBRIC: cap/a layout: pass - grid has three columns on both\n"
	for _, it := range RubricItems[1:] {
		ok += "RUBRIC: a " + it + ": pass - compared the cards on both sides\n"
	}
	if p := RubricProblems(ok, []string{"cap/a"}, "pass", nil); len(p) != 0 {
		t.Fatalf("complete rubric: %v", p)
	}
	if p := RubricProblems("RUBRIC: cap/a layout: fail - x\n", []string{"cap/a"}, "pass", nil); len(p) != 7 {
		t.Fatalf("want 5 missing, 1 uncited and the missing DEFECT, got %d: %v", len(p), p)
	}
}
