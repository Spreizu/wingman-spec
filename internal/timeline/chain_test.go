package timeline

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func chainOf(t *testing.T, n int) (string, [][]byte) {
	t.Helper()
	dir := t.TempDir()
	for i := range n {
		Append(dir, Event{Event: "e", Summary: strings.Repeat("s", i+1)})
	}
	b, _ := os.ReadFile(filepath.Join(dir, File))
	return dir, bytes.SplitAfter(bytes.TrimRight(b, "\n"), []byte("\n"))
}

func write(t *testing.T, dir string, lines [][]byte) string {
	t.Helper()
	f := filepath.Join(dir, File)
	if err := os.WriteFile(f, bytes.Join(lines, nil), 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestChainDetectsEditDeleteReorderInsert(t *testing.T) {
	dir, ls := chainOf(t, 4)
	if c := Verify(filepath.Join(dir, File)); c.Break != nil || c.Entries != 4 || len(c.Head) != 64 {
		t.Fatalf("intact chain = %+v", c)
	}
	nl := func(b []byte) []byte { return append(bytes.TrimRight(b, "\n"), '\n') }
	cases := map[string]struct {
		lines [][]byte
		line  int
		want  string
	}{
		"edit":    {[][]byte{ls[0], bytes.Replace(ls[1], []byte(`"ss"`), []byte(`"xx"`), 1), ls[2], ls[3]}, 3, "entry 2 was edited"},
		"delete":  {[][]byte{ls[0], ls[2], nl(ls[3])}, 2, "does not follow entry 1"},
		"first":   {[][]byte{ls[1], ls[2], ls[3]}, 1, "does not start the chain"},
		"reorder": {[][]byte{ls[0], ls[2], ls[1], nl(ls[3])}, 2, "does not follow"},
		"insert":  {[][]byte{ls[0], []byte("{\"at\":\"x\",\"event\":\"e\",\"summary\":\"fake\"}\n"), ls[1], ls[2], ls[3]}, 2, "no link"},
	}
	for name, tc := range cases {
		c := Verify(write(t, t.TempDir(), tc.lines))
		if c.Break == nil || c.Break.Line != tc.line || !strings.Contains(c.Break.String(), tc.want) {
			t.Errorf("%s: break = %+v", name, c.Break)
		}
	}
	// Windows line endings (git autocrlf) keep the chain.
	crlf := bytes.ReplaceAll(bytes.Join(ls, nil), []byte("\n"), []byte("\r\n"))
	if c := Verify(write(t, t.TempDir(), [][]byte{crlf})); c.Break != nil {
		t.Errorf("CRLF chain broke: %+v", c.Break)
	}
	// Lines from before the chain are accepted; the first chained line links to them.
	old := t.TempDir()
	write(t, old, [][]byte{[]byte("{\"at\":\"a\",\"event\":\"old\",\"summary\":\"\"}\n")})
	Append(old, Event{Event: "new"})
	if c := Verify(filepath.Join(old, File)); c.Break != nil || c.Entries != 2 {
		t.Errorf("legacy + chained = %+v", c)
	}
}

func TestArchiveAnchorCatchesTheLastEntry(t *testing.T) {
	_, ls := chainOf(t, 3)
	arch := t.TempDir()
	write(t, arch, ls)
	if _, err := WriteArchived(arch, time.Now(), ""); err != nil {
		t.Fatal(err)
	}
	Anchor(arch)
	if c := VerifyArchived(arch); c.Break != nil {
		t.Fatalf("anchored chain = %+v", c.Break)
	}
	write(t, arch, ls[:2]) // drop the last entry: the chain itself still holds
	if Verify(filepath.Join(arch, File)).Break != nil {
		t.Fatal("chain alone should not see a dropped last entry")
	}
	if c := VerifyArchived(arch); c.Break == nil || !strings.Contains(c.Problem("t"), "archived.json") {
		t.Errorf("anchor missed the dropped entry: %+v", c)
	}
}

func TestArtifactsRecordsLostVisualBlocks(t *testing.T) {
	ch, runs := t.TempDir(), t.TempDir()
	spec := "## ADDED Requirements\n### Requirement: R\n#### Scenario: Blocked\n- THEN banner\n```visual\nurl: /\n```\n#### Scenario: Plain\n- THEN ok\n"
	if err := os.MkdirAll(filepath.Join(ch, "specs"), 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(ch, "specs", "shop.md")
	_ = os.WriteFile(f, []byte(spec), 0o644)
	Artifacts(runs, ch, "validate", "")
	_ = os.WriteFile(filepath.Join(ch, "design.md"), []byte("# D\n"), 0o644)
	_ = os.WriteFile(f, []byte(strings.Replace(spec, "```visual\nurl: /\n```\n", "", 1)), 0o644)
	Artifacts(runs, ch, "lint", "")
	Artifacts(runs, ch, "lint", "") // nothing changed: no event
	evs := Read(filepath.Join(runs, File))
	var sums []string
	for _, e := range evs {
		sums = append(sums, e.Summary)
	}
	got := strings.Join(sums, " | ")
	if len(evs) != 3 || got != "wrote specs/shop.md | wrote design.md | rewrote specs/shop.md (1 scenario or visual change(s))" {
		t.Fatalf("events = %s", got)
	}
	if c := evs[2].Details["changes"]; !strings.Contains(strings.Join(anyStrings(c), ","), "visual block removed: Blocked") {
		t.Errorf("changes = %v", c)
	}
}

func anyStrings(v any) []string {
	var out []string
	if xs, ok := v.([]any); ok {
		for _, x := range xs {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
