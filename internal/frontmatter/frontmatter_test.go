package frontmatter

import "testing"

func TestParseListsAndScalars(t *testing.T) {
	text := "---\ntitle: Hello\nroles: [a, \"b\"]\nstatus: none # later\ncovers:\n  - one\n  - two\n---\nbody\n"
	m, body, ok := Parse(text)
	if !ok || body != "body\n" {
		t.Fatalf("Parse() ok=%v body=%q", ok, body)
	}
	if m.Str("title") != "Hello" || m.Str("covers") != "one,two" {
		t.Errorf("map = %#v", m)
	}
	if got := m.List("roles"); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("roles = %#v", got)
	}
	st, ok := Status(text)
	if !ok || st != "none" {
		t.Errorf("Status() = %q, %v", st, ok)
	}
}

func TestParseMissing(t *testing.T) {
	in := "no front\r\nmatter\r\n"
	_, body, ok := Parse(in)
	if ok || body != "no front\nmatter\n" {
		t.Errorf("Parse(missing) = %q, %v", body, ok)
	}
}
