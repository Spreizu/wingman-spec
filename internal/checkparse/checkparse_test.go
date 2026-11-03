package checkparse

import (
	"os"
	"strings"
	"testing"
)

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The fixtures are the real output of each tool run on a small failing project.
func TestParseFixtures(t *testing.T) {
	cases := []struct {
		file, format, counts string
		first                Failure
	}{
		{"eslint.txt", "eslint", "2 errors", Failure{File: "/work/app/src/lint.js", Line: 1, Col: 5, Message: "'a' is assigned a value but never used (no-unused-vars)"}},
		{"go.txt", "go test", "1 failed", Failure{File: "x_test.go", Line: 4, Name: "TestB", Message: "want 1 got 2"}},
		{"gov.txt", "go test", "1 failed, 1 passed, 1 skipped", Failure{File: "x_test.go", Line: 4, Name: "TestB", Message: "want 1 got 2"}},
		{"jest.txt", "jest", "1 failed, 1 passed", Failure{File: "src/b.jtest.cjs", Line: 3, Name: "math › fails here", Message: "expect(received).toBe(expected) // Object.is equality"}},
		{"tap.txt", "tap", "2 failed, 2 passed", Failure{File: "/work/app/src/n.test.mjs", Line: 5, Name: "inner bad", Message: "Expected values to be strictly equal:"}},
		{"nodespec.txt", "node", "2 failed, 2 passed, 1 skipped", Failure{File: "src/n.test.mjs", Line: 5, Name: "inner bad", Message: "Expected values to be strictly equal:"}},
		{"pytest.txt", "pytest", "1 failed, 1 passed, 1 skipped", Failure{File: "py/test_x.py", Line: 3, Name: "test_bad", Message: "assert 1 == 2"}},
		{"tsc.txt", "tsc", "2 errors", Failure{File: "src/t.ts", Line: 1, Col: 7, Message: "TS2322: Type 'string' is not assignable to type 'number'."}},
		{"tscpretty.txt", "tsc", "2 errors", Failure{File: "src/t.ts", Line: 1, Col: 7, Message: "TS2322: Type 'string' is not assignable to type 'number'."}},
		{"vitest.txt", "vitest", "1 failed, 1 passed, 1 skipped", Failure{File: "src/a.test.js", Line: 4, Name: "math > fails [calc/subtracts]", Message: "AssertionError: expected 1 to be 3 // Object.is equality"}},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			s := Parse(read(t, c.file), nil)
			if strings.Join(s.Formats, ",") != c.format || s.Counts() != c.counts {
				t.Fatalf("got %v %q, want %s %q", s.Formats, s.Counts(), c.format, c.counts)
			}
			if len(s.Failures) == 0 || s.Failures[0] != c.first {
				t.Fatalf("first failure %+v, want %+v", s.Failures, c.first)
			}
		})
	}
}

func TestParseJUnit(t *testing.T) {
	s := Parse("whatever the reporter printed", []byte(read(t, "junit.xml")))
	if strings.Join(s.Formats, ",") != "junit" || s.Counts() != "1 failed, 1 passed, 1 skipped" {
		t.Fatalf("%v %q", s.Formats, s.Counts())
	}
	if f := s.Failures[0]; f.File != "src/a.test.js" || f.Line != 4 || !strings.Contains(f.Name, "fails [calc/subtracts]") || f.Message != "expected 1 to be 3 // Object.is equality" {
		t.Fatalf("%+v", f)
	}
	if s := Parse("", []byte("<html>not junit</html>")); s.Read() {
		t.Fatalf("html read as junit: %+v", s)
	}
}

// One command can run several tools (`tsc && vitest`): every format whose lines appear is read.
func TestParseCombined(t *testing.T) {
	s := Parse(read(t, "tsc.txt")+"\n"+read(t, "vitest.txt"), nil)
	if strings.Join(s.Formats, ",") != "vitest,tsc" || s.Counts() != "1 failed, 2 errors, 1 passed, 1 skipped" || len(s.Failures) != 3 {
		t.Fatalf("%v %q %+v", s.Formats, s.Counts(), s.Failures)
	}
}

func TestParseUnknownAndCap(t *testing.T) {
	if s := Parse("Segmentation fault\nsomething broke\n", nil); s.Read() || len(s.Failures) != 0 {
		t.Fatalf("unknown output read: %+v", s)
	}
	var b strings.Builder
	for i := range 40 {
		b.WriteString("src/a.ts(" + string(rune('1'+i%9)) + ",1): error TS1005: x" + strings.Repeat("y", i) + "\n")
	}
	s := Parse(b.String(), nil)
	if s.Errors != 40 || len(s.Failures) != MaxFailures || s.More != 40-MaxFailures {
		t.Fatalf("%d errors, %d listed, %d more", s.Errors, len(s.Failures), s.More)
	}
	if l := s.Lines(); !strings.Contains(l[len(l)-1], "and 25 more") {
		t.Fatalf("%q", l)
	}
	long := Parse("src/a.ts(1,1): error TS1: "+strings.Repeat("é", 500), nil)
	if r := []rune(long.Failures[0].Message); len(r) != 200 {
		t.Fatalf("message not clipped: %d", len(r))
	}
}

func TestParseESLintUnix(t *testing.T) {
	s := Parse("src/a.js:3:7: 'x' is defined but never used. [Error/no-unused-vars]\nsrc/a.js:4:1: Unexpected var. [Warning/no-var]\n", nil)
	if s.Errors != 1 || s.Failures[0] != (Failure{File: "src/a.js", Line: 3, Col: 7, Message: "'x' is defined but never used. (no-unused-vars)"}) {
		t.Fatalf("%+v", s)
	}
	if got := s.Failures[0].String(); got != "src/a.js:3:7: 'x' is defined but never used. (no-unused-vars)" {
		t.Errorf("String() = %q", got)
	}
}

func TestParseANSI(t *testing.T) {
	s := Parse("\x1b[31msrc/t.ts\x1b[0m:\x1b[33m1\x1b[0m:\x1b[33m7\x1b[0m - \x1b[91merror\x1b[0m TS2322: bad\r\n", nil)
	if s.Errors != 1 || s.Failures[0].File != "src/t.ts" {
		t.Fatalf("%+v", s)
	}
}

// A JUnit report reads as TAP lines: a failure or error is `not ok`, a skipped case `ok ... # SKIP`, nested suites too.
func TestJUnitLines(t *testing.T) {
	x := `<testsuites><testsuite name="a"><testcase classname="todo" name="[todo/added] adds"/>` +
		`<testcase name="[todo/removed]"><failure message="m"/></testcase><testcase name="[todo/x]"><error/></testcase>` +
		`<testsuite name="b"><testcase name="[todo/cleared]"><skipped/></testcase></testsuite></testsuite></testsuites>`
	want := "ok - todo [todo/added] adds\nnot ok - [todo/removed]\nnot ok - [todo/x]\nok - [todo/cleared] # SKIP\n"
	if got := JUnitLines([]byte(x)); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if JUnitLines([]byte("not xml")) != "" || JUnitLines(nil) != "" {
		t.Error("not a JUnit report: want empty")
	}
}
