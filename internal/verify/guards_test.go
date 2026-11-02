package verify

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/change"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/visual"
)

func vblock(name, block string) string {
	return "#### Scenario: " + name + "\n- **WHEN** the page opens\n- **THEN** it shows\n\n```visual\nroute: /favorites\n" + block + "\n```\n"
}

// The guards are the living scenarios as specs/ reads after archive: a scenario dropped from a MODIFIED requirement or
// under a REMOVED one is gone, the others stay, and a delta that does not merge leaves its capability unguarded.
func TestAfterArchive(t *testing.T) {
	d := t.TempDir()
	if err := os.WriteFile(filepath.Join(d, layout.ConfigFile), []byte("context: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := layout.Find(d, "")
	if err != nil {
		t.Fatal(err)
	}
	put := func(p, s string) {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put(filepath.Join(r.LivingSpecs(), "favorites.md"), "# favorites\n\n## Purpose\nFavorites keep the items a person wants to find again.\n\n## Requirements\n\n"+
		"### Requirement: List shows availability\nThe list SHALL show availability.\n\n"+vblock("Unavailable item shows a disabled row", "key: input.quantity[disabled]")+"\n"+vblock("Available item shows an add button", "key: [data-testid=\"favorite-add\"]")+"\n"+
		"### Requirement: Old banner\nThe list SHALL show a banner.\n\n"+vblock("Banner shows", "key: .banner")+"\n"+
		"### Requirement: Header heart\nThe header SHALL show a heart.\n\n"+vblock("Heart shows", "key: .heart"))
	cdir := filepath.Join(r.Changes(), "omit-unavailable")
	put(filepath.Join(cdir, "specs", "favorites.md"), "## MODIFIED\n\n### Requirement: List shows availability\nThe list SHALL omit unavailable items.\n\n"+vblock("Available item shows an add button", "key: [data-testid=\"favorite-add\"]")+"\n"+vblock("Unavailable item is omitted", "key: main\nabsent: input.quantity")+
		"\n## REMOVED\n\n### Requirement: Old banner\n**Reason**: gone\n**Migration**: none\n")
	own := visual.ParseScenarios(filepath.Join(cdir, "specs"))
	living := visual.ParseScenarios(r.LivingSpecs())
	m, err := change.Merged(r, cdir, false)
	if err != nil || len(m.Problems) > 0 {
		t.Fatalf("merge: %v %v", err, m)
	}
	if got := ids(afterArchive(m, living, own)); !slices.Equal(got, []string{"favorites/heart-shows"}) {
		t.Errorf("guards = %v, want only the untouched requirement's scenario", got)
	}
	if _, err := os.Stat(filepath.Join(cdir, "spec-base.json")); err == nil {
		t.Error("Merged without pin wrote spec-base.json")
	}
	put(filepath.Join(cdir, "specs", "favorites.md"), "## MODIFIED\n\n### Requirement: No such requirement\nThe list SHALL x.\n\n"+vblock("X", "key: main"))
	m, _ = change.Merged(r, cdir, false)
	if got := afterArchive(m, living, nil); len(m.Failed) != 1 || len(got) != 0 || !strings.Contains(strings.Join(m.Problems, ""), "no requirement") {
		t.Errorf("a delta that does not merge: failed %v, guards %v, problems %v", m.Failed, ids(got), m.Problems)
	}
}
