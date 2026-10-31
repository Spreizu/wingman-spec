package trace

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func archived(t *testing.T, dir, name, at string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, name, "archived.json"), `{ "archived_at": "`+at+`" }`)
}

// Archives of one day sort by archived_at, not by name; an offset is honoured; equal times tie by name.
func TestArchiveOrder(t *testing.T) {
	a := t.TempDir()
	archived(t, a, "2026-10-28-0915-mango", "2026-10-28T09:15:00+02:00")
	archived(t, a, "2026-10-28-1640-apple", "2026-10-28T16:40:05+02:00")
	archived(t, a, "2026-10-28-0800-zebra", "2026-10-28T08:00:30+02:00")
	archived(t, a, "2026-10-27-2359-late", "2026-10-27T23:59:59+02:00")
	archived(t, a, "x-utc", "2026-10-28T07:30:00+00:00")                                   // 09:30 at +02:00
	archived(t, a, "b-tie", "2026-10-28T16:40:05+02:00")                                   // same time as apple: ties by name
	if err := os.MkdirAll(filepath.Join(a, "2026-10-28-1700-nofile"), 0o755); err != nil { // no archived.json: the name's time
		t.Fatal(err)
	}
	got := strings.Join(ArchiveOrder(a), ",")
	want := "2026-10-27-2359-late,2026-10-28-0800-zebra,2026-10-28-0915-mango,x-utc,2026-10-28-1640-apple,b-tie,2026-10-28-1700-nofile"
	if got != want {
		t.Errorf("order:\n got %s\nwant %s", got, want)
	}
}

// zeta added a requirement at 08:00 and alpha removed it at 09:00: the replay ends with it gone (name order would keep
// it); archived the other way round, it stays expected.
func TestArchivedExpectationReplaysByTime(t *testing.T) {
	root := t.TempDir()
	r := &layout.Root{Code: root, Specs: root}
	arch := r.Archive()
	writeFile(t, filepath.Join(r.LivingSpecs(), "todo.md"), "## Requirements\n\n### Requirement: Keep\nThe system SHALL keep a list.\n")
	writeFile(t, filepath.Join(arch, "2026-10-28-zeta", "specs", "todo.md"), "## ADDED\n\n### Requirement: Extra\nThe system SHALL do more.\n")
	writeFile(t, filepath.Join(arch, "2026-10-28-alpha", "specs", "todo.md"), "## REMOVED\n\n### Requirement: Extra\n")
	archived(t, arch, "2026-10-28-zeta", "2026-10-28T08:00:00+02:00")
	archived(t, arch, "2026-10-28-alpha", "2026-10-28T09:00:00+02:00")
	c := Ctx{R: r}
	if keys, _ := c.ArchivedExpectation(""); len(keys) != 0 {
		t.Errorf("removed later: want nothing expected, got %v", keys)
	}
	archived(t, arch, "2026-10-28-zeta", "2026-10-28T10:00:00+02:00")
	if keys, _ := c.ArchivedExpectation(""); !slices.Equal(keys, []string{"todo/extra"}) {
		t.Errorf("added last: want [todo/extra], got %v", keys)
	}
}
