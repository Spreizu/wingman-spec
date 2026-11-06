package layout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCut(t *testing.T) {
	if got := Cut("héllo", 3); got != "hél" {
		t.Errorf("Cut(%q, 3) = %q, want %q", "héllo", got, "hél")
	}
	if got := Cut("ab", 5); got != "ab" {
		t.Errorf("Cut(%q, 5) = %q, want %q", "ab", got, "ab")
	}
}

func TestReadStringAndLines(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("one\r\ntwo\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, ok := ReadString(p)
	if !ok || got != "one\r\ntwo\r\n" {
		t.Errorf("ReadString() = %q, %v", got, ok)
	}
	if _, ok := ReadString(filepath.Join(dir, "missing")); ok {
		t.Error("ReadString(missing) ok = true, want false")
	}
	lines := Lines(p)
	if strings.Join(lines, "|") != "one|two|" {
		t.Errorf("Lines() = %#v, want one, two, empty", lines)
	}
	if Lines(filepath.Join(dir, "missing")) != nil {
		t.Error("Lines(missing) is not nil")
	}
}

func TestStripCommentsKeepsLineCount(t *testing.T) {
	in := "a\n<!--\n hidden\n-->\nb <!-- x --> c\n"
	got := StripComments(in, true)
	if strings.Count(got, "\n") != strings.Count(in, "\n") {
		t.Errorf("StripComments keepLines newlines = %d, want %d\n%q", strings.Count(got, "\n"), strings.Count(in, "\n"), got)
	}
	if strings.Contains(got, "hidden") || strings.Contains(got, "x") {
		t.Errorf("StripComments keepLines = %q, comment text remains", got)
	}
	if StripComments(in, false) != "a\n\nb  c\n" {
		t.Errorf("StripComments drop = %q", StripComments(in, false))
	}
}

func TestExists(t *testing.T) {
	dir := t.TempDir()
	if !Exists(dir) {
		t.Errorf("Exists(%q) = false, want true", dir)
	}
	if Exists(filepath.Join(dir, "nope")) {
		t.Error("Exists(missing) = true, want false")
	}
}
