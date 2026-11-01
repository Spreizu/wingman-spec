package spec

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// pinned is the base of d in living, as the change would have recorded it when planned.
func pinned(living string, d *Delta) *Base { b := BaseOf(living, d); return &b }

func TestMergeRefuses(t *testing.T) {
	const req = "The system SHALL x.\n\n#### Scenario: s\n- x\n"
	tests := []struct{ name, delta, want string }{
		{"added twice", "## ADDED\n### Requirement: New\n" + req + "\n### Requirement: new\n" + req, `"new" is named twice`},
		{"modified twice", "## MODIFIED\n### Requirement: Greet\n" + req + "\n### Requirement: Greet\n" + req, `"Greet" is named twice`},
		{"modified and removed", "## REMOVED\n### Requirement: Greet\n\n## MODIFIED\n### Requirement: Greet\n" + req, "named twice"},
		{"added and removed", "## REMOVED\n### Requirement: Greet\n\n## ADDED\n### Requirement: Greet\n" + req, "named twice"},
		{"modify old name of a rename", "## RENAMED\n- Greet -> Greeting\n\n## MODIFIED\n### Requirement: Greet\n" + req, "named twice"},
		{"remove old name of a rename", "## RENAMED\n- Greet -> Greeting\n\n## REMOVED\n### Requirement: Greet\n", "named twice"},
		{"remove new name of a rename", "## RENAMED\n- Greet -> Greeting\n\n## REMOVED\n### Requirement: Greeting\n", "renaming onto an ADDED or REMOVED name"},
		{"add new name of a rename", "## RENAMED\n- Greet -> Greeting\n\n## ADDED\n### Requirement: Greeting\n" + req, "renaming onto an ADDED or REMOVED name"},
		{"add old name of a rename", "## RENAMED\n- Greet -> Greeting\n\n## ADDED\n### Requirement: Greet\n" + req, "named twice"},
		{"rename chain", "## RENAMED\n- Greet -> Old pager x\n- Old pager x -> Y\n", "rename chains, swaps"},
		{"rename swap", "## RENAMED\n- Greet -> Old pager\n- Old pager -> Greet\n", "rename chains, swaps"},
		{"two renames to one name", "## RENAMED\n- Greet -> Same\n- Old pager -> same\n", `two requirements get the name "same"`},
		{"case-only rename", "## RENAMED\n- Greet -> greet\n", "a change of case or spacing is not a rename"},
		{"rename onto existing", "## RENAMED\n- Greet -> Old pager\n", "already exists"},
		{"rename missing", "## RENAMED\n- Nope -> Yes\n", `RENAMED: no requirement "Nope"`},
		{"modify missing", "## MODIFIED\n### Requirement: Nope\n" + req, `MODIFIED: no requirement "Nope"`},
		{"remove missing", "## REMOVED\n### Requirement: Nope\n", `REMOVED: no requirement "Nope"`},
		{"add existing", "## ADDED\n### Requirement: Greet\n" + req, `ADDED: requirement "Greet" already exists`},
		{"duplicate scenario", "## ADDED\n### Requirement: New\nThe system SHALL x.\n\n#### Scenario: One\n- x\n\n#### Scenario: one\n- y\n", `scenario "one" repeats`},
		{"purpose on existing", "## Purpose\nA purpose long enough to count as one for this capability here.\n\n## ADDED\n### Requirement: New\n" + req, "## Purpose is only for a new capability"},
		{"legacy heading", "## ADDED Requirements\n### Requirement: X\n" + req, "write `## ADDED`"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := ParseDelta(tt.delta)
			for _, base := range []*Base{nil, pinned(living, d)} {
				_, err := Merge("demo", living, d, base)
				if err == nil || !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("base %v: err = %v, want it to contain %q", base != nil, err, tt.want)
				}
				if _, ok := errors.AsType[*MergeError](err); !ok {
					t.Errorf("not a MergeError: %T", err)
				}
			}
		})
	}
}

func TestMergeLivingDuplicates(t *testing.T) {
	dup := strings.Replace(living, "### Requirement: Old pager", "### Requirement: greet", 1)
	_, err := Merge("demo", dup, ParseDelta("## ADDED\n### Requirement: New\nThe system SHALL x.\n\n#### Scenario: s\n- x\n"), nil)
	if err == nil || !strings.Contains(err.Error(), "is in the living spec twice") {
		t.Fatalf("err = %v", err)
	}
}

func TestMergeRenameRebuildsHeading(t *testing.T) {
	l := strings.Replace(living, "### Requirement: Greet", "### Requirement:   Requirement", 1)
	got, err := Merge("demo", l, ParseDelta("## RENAMED\n- Requirement -> Greeting\n"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "\n### Requirement: Greeting\nThe system SHALL greet.\n") {
		t.Errorf("got:\n%s", got)
	}
}

func TestMergeBase(t *testing.T) {
	d := ParseDelta("## RENAMED\n- Greet -> Greeting\n\n## MODIFIED\n### Requirement: Greeting\nThe system SHALL greet by name.\n\n#### Scenario: hello\n- x\n\n## REMOVED\n### Requirement: Old pager\n")
	base := pinned(living, d)
	if len(base.Requirements) != 2 || !base.Exists {
		t.Fatalf("base = %+v", base)
	}
	// another change edits a requirement this delta modifies (through the rename), or one it removes
	for _, edit := range []string{"The system SHALL greet.", "The system SHALL page."} {
		moved := strings.Replace(living, edit, strings.TrimSuffix(edit, ".")+" politely.", 1)
		if _, err := Merge("demo", moved, d, base); err == nil || !strings.Contains(err.Error(), "base changed") {
			t.Errorf("edit %q: err = %v", edit, err)
		}
		if _, err := Merge("demo", moved, d, pinned(moved, d)); err != nil {
			t.Errorf("after a rebase: %v", err)
		}
	}
	// a requirement the delta does not touch may change
	other := ParseDelta("## REMOVED\n### Requirement: Old pager\n")
	b2 := pinned(living, other)
	if _, err := Merge("demo", strings.Replace(living, "it says hello", "it says hi", 1), other, b2); err != nil {
		t.Errorf("unrelated edit: %v", err)
	}
	// no base recorded for a requirement the delta now names
	if _, err := Merge("demo", living, d, &Base{Exists: true}); err == nil || !strings.Contains(err.Error(), "no base recorded") {
		t.Errorf("missing pin: %v", err)
	}
	// a new capability that another change created meanwhile, and a living spec deleted meanwhile
	add := ParseDelta("## ADDED\n### Requirement: New\nThe system SHALL x.\n\n#### Scenario: s\n- x\n")
	if _, err := Merge("demo", living, add, &Base{}); err == nil || !strings.Contains(err.Error(), "created this capability") {
		t.Errorf("created meanwhile: %v", err)
	}
	if _, err := Merge("demo", "", add, &Base{Exists: true}); err == nil || !strings.Contains(err.Error(), "deleted") {
		t.Errorf("deleted meanwhile: %v", err)
	}
}

func TestMergeIdempotent(t *testing.T) {
	d := ParseDelta("## RENAMED\n- Greet -> Greeting\n\n## REMOVED\n### Requirement: Old pager\n\n## ADDED\n### Requirement: Wave\nThe system SHALL wave.\n\n#### Scenario: w\n- x\n")
	base := pinned(living, d)
	once, err := Merge("demo", living, d, base)
	if err != nil {
		t.Fatal(err)
	}
	twice, err := Merge("demo", once, d, base)
	if err != nil || twice != once {
		t.Fatalf("second merge: %v\n%s", err, twice)
	}
	// without the base it cannot tell a removed requirement from one that never existed
	if _, err := Merge("demo", once, d, nil); err == nil {
		t.Error("merged again without a base")
	}
	add := ParseDelta("## Purpose\nLists items for the people who keep them in one place.\n\n## ADDED\n### Requirement: L\nThe system SHALL l.\n\n#### Scenario: s\n- x\n")
	created, err := Merge("items", "", add, &Base{})
	if err != nil {
		t.Fatal(err)
	}
	if again, err := Merge("items", created, add, &Base{}); err != nil || again != created {
		t.Errorf("new capability merged twice: %v", err)
	}
}

func TestMergeRoundTripRefusal(t *testing.T) {
	// a MODIFIED block whose text would read back as two requirements
	d := &Delta{Modified: []Requirement{{Name: "Greet", Line: 3, Text: "### Requirement: Greet\nThe system SHALL greet.\n\n### Requirement: Sneaky\nThe system SHALL x."}}}
	if _, err := Merge("demo", living, d, nil); err == nil || !strings.Contains(err.Error(), "would not read back the same") {
		t.Fatalf("err = %v", err)
	}
}

// ---------- property tests ----------

var words = []string{"list", "save", "share", "sort", "filter", "export", "import", "notify", "archive", "search", "tag", "pin", "rate", "merge", "split"}

func name(r *rand.Rand, used map[string]bool) string {
	for {
		n := fmt.Sprintf("%s %s %d", words[r.IntN(len(words))], words[r.IntN(len(words))], r.IntN(100))
		n = strings.ToUpper(n[:1]) + n[1:]
		if !used[Key(n)] {
			used[Key(n)] = true
			return n
		}
	}
}

func block(r *rand.Rand, n string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "### Requirement: %s\nThe app SHALL %s things %d.\n", n, words[r.IntN(len(words))], r.IntN(1000))
	for i := range 1 + r.IntN(3) {
		fmt.Fprintf(&b, "\n#### Scenario: case %d %s\n- **WHEN** %s\n- **THEN** %s\n", i, words[r.IntN(len(words))], words[r.IntN(len(words))], words[r.IntN(len(words))])
		if r.IntN(4) == 0 {
			b.WriteString("\n```visual\nroute: /x\n### not a heading\n```\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

type model struct {
	names  []string
	blocks map[string]string
}

// randomCase builds a living spec and a valid delta, and the requirements (names in order, text by name) the merge
// must produce, from a plain model of the semantics.
func randomCase(r *rand.Rand) (string, *Delta, []string, map[string]string) {
	used := map[string]bool{}
	m := model{blocks: map[string]string{}}
	var lb strings.Builder
	lb.WriteString("# cap\n\n## Purpose\nThe purpose of this capability is described here in one sentence.\n\n## Requirements\n")
	for range 1 + r.IntN(8) {
		n := name(r, used)
		m.names = append(m.names, n)
		m.blocks[n] = block(r, n)
		lb.WriteString("\n" + m.blocks[n] + "\n")
	}
	if r.IntN(2) == 0 {
		lb.WriteString("\n## Notes\nkept\n")
	}
	var db strings.Builder
	order := r.Perm(len(m.names))
	var renamed, removed, modified []string
	for _, i := range order {
		switch r.IntN(4) {
		case 0:
			renamed = append(renamed, m.names[i])
		case 1:
			removed = append(removed, m.names[i])
		case 2:
			modified = append(modified, m.names[i])
		}
	}
	want := slices.Clone(m.names)
	text := map[string]string{}
	for _, n := range m.names {
		text[n] = m.blocks[n]
	}
	if len(renamed) > 0 {
		db.WriteString("## RENAMED\n")
		for _, from := range renamed {
			to := name(r, used)
			fmt.Fprintf(&db, "- %s -> %s\n", from, to)
			want[slices.Index(want, from)] = to
			_, rest, _ := strings.Cut(text[from], "\n")
			text[to] = "### Requirement: " + to + "\n" + rest
			delete(text, from)
			if r.IntN(2) == 0 {
				modified = append(modified, to)
			}
		}
		db.WriteString("\n")
	}
	if len(removed) > 0 {
		db.WriteString("## REMOVED\n")
		for _, n := range removed {
			fmt.Fprintf(&db, "### Requirement: %s\nReason: gone\n\n", n)
			want = slices.DeleteFunc(want, func(x string) bool { return x == n })
			delete(text, n)
		}
	}
	if len(modified) > 0 {
		db.WriteString("## MODIFIED\n")
		for _, n := range modified {
			text[n] = block(r, n)
			db.WriteString(text[n] + "\n\n")
		}
	}
	adds := r.IntN(3)
	if adds > 0 || db.Len() == 0 {
		db.WriteString("## ADDED\n")
		for range max(adds, 1) {
			n := name(r, used)
			text[n] = block(r, n)
			want = append(want, n)
			db.WriteString(text[n] + "\n\n")
		}
	}
	return lb.String(), ParseDelta(db.String()), want, text
}

func TestMergeProperties(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 11))
	for i := range 500 {
		lv, d, want, text := randomCase(r)
		if len(d.Problems) > 0 {
			t.Fatalf("case %d: delta problems %v", i, d.Problems)
		}
		base := pinned(lv, d)
		got, err := Merge("cap", lv, d, base)
		if err != nil {
			t.Fatalf("case %d: %v\nliving:\n%s", i, err, lv)
		}
		sp := ParseLiving(got)
		var names []string
		for _, q := range sp.Requirements {
			names = append(names, q.Name)
			if norm(q.Text) != norm(text[q.Name]) {
				t.Fatalf("case %d: %q text\n%s\nwant\n%s", i, q.Name, q.Text, text[q.Name])
			}
		}
		if !slices.Equal(names, want) || len(sp.Problems) > 0 {
			t.Fatalf("case %d: requirements %v, want %v (%v)", i, names, want, sp.Problems)
		}
		if strings.Contains(lv, "## Notes") != strings.Contains(got, "\n## Notes\nkept\n") {
			t.Fatalf("case %d: the tail moved", i)
		}
		if p := Synced(got, d); len(p) > 0 {
			t.Fatalf("case %d: not synced after the merge: %v", i, p)
		}
		again, err := Merge("cap", got, d, base)
		if err != nil || again != got {
			t.Fatalf("case %d: not idempotent: %v", i, err)
		}
		// a living spec rendered by Merge round-trips through ParseLiving and Render
		if ParseLiving(got).Render() != got {
			t.Fatalf("case %d: render is not stable", i)
		}
	}
}

// TestMergeConflictProperties breaks a valid random delta in one of the refused ways: every one is refused.
func TestMergeConflictProperties(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 5))
	kinds := []string{"add-existing", "modify-missing", "remove-missing", "rename-missing", "rename-onto", "twice", "base-changed"}
	for i := range 400 {
		lv, d, _, _ := randomCase(r)
		existing := ParseLiving(lv).Requirements
		si := r.IntN(len(existing))
		some := existing[si]
		base := pinned(lv, d)
		living := lv
		kind := kinds[i%len(kinds)]
		switch kind {
		case "add-existing":
			d.Added = append(d.Added, Requirement{Name: some.Name, Line: 99, Text: "### Requirement: " + some.Name + "\nThe app SHALL other."})
		case "modify-missing":
			d.Modified = append(d.Modified, Requirement{Name: "Never there", Line: 99, Text: "### Requirement: Never there\nThe app SHALL x."})
		case "remove-missing":
			d.Removed = append(d.Removed, Requirement{Name: "Never there", Line: 99})
		case "rename-missing":
			d.Renamed = append(d.Renamed, Rename{From: "Never there", To: "Fresh name", Line: 99})
		case "rename-onto":
			if len(existing) < 2 {
				continue
			}
			other := existing[(si+1)%len(existing)]
			d.Renamed = append(d.Renamed, Rename{From: some.Name, To: other.Name, Line: 99})
		case "twice":
			if len(d.Added) == 0 {
				continue
			}
			d.Added = append(d.Added, d.Added[0])
		case "base-changed":
			names := d.baseNames()
			if len(names) == 0 {
				continue
			}
			n := names[r.IntN(len(names))]
			sp := ParseLiving(lv)
			j := slices.IndexFunc(sp.Requirements, func(q Requirement) bool { return Key(q.Name) == Key(n) })
			sp.Requirements[j].Text = strings.Replace(sp.Requirements[j].Text, "The app SHALL", "The app MUST", 1)
			living = sp.Render()
		}
		if _, err := Merge("cap", living, d, base); err == nil {
			t.Fatalf("case %d (%s): merged", i, kind)
		}
	}
}

func TestPinBases(t *testing.T) {
	dir, livingDir := t.TempDir(), t.TempDir()
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(livingDir, "demo.md"), living)
	write(filepath.Join(dir, "specs", "demo.md"), "## REMOVED\n### Requirement: Old pager\n")
	write(filepath.Join(dir, "specs", "items.md"), "## ADDED\n### Requirement: L\nThe system SHALL l.\n\n#### Scenario: s\n- x\n")
	bases, _, err := PinBases(dir, livingDir, false, true)
	if err != nil || !bases["demo"].Exists || bases["demo"].Requirements["old pager"] == "" || bases["items"].Exists {
		t.Fatalf("bases = %+v %v", bases, err)
	}
	// a recorded base stays when the living spec moves; a rebase records it again and names it
	write(filepath.Join(livingDir, "demo.md"), strings.Replace(living, "SHALL page", "SHALL page fast", 1))
	again, _, _ := PinBases(dir, livingDir, false, true)
	if again["demo"].Requirements["old pager"] != bases["demo"].Requirements["old pager"] {
		t.Error("a recorded base changed without a rebase")
	}
	_, moved, err := PinBases(dir, livingDir, true, true)
	if err != nil || !slices.Equal(moved, []string{"demo/old pager"}) {
		t.Errorf("rebase moved %v %v", moved, err)
	}
	// a delta that no longer names a requirement drops its entry; a removed delta drops the capability
	write(filepath.Join(dir, "specs", "demo.md"), "## ADDED\n### Requirement: More\nThe system SHALL m.\n\n#### Scenario: s\n- x\n")
	if err := os.Remove(filepath.Join(dir, "specs", "items.md")); err != nil {
		t.Fatal(err)
	}
	got, _, _ := PinBases(dir, livingDir, false, true)
	if len(got) != 1 || got["demo"].Requirements != nil {
		t.Errorf("after the delta changed: %+v", got)
	}
	read, err := ReadBases(dir)
	if err != nil || len(read) != 1 {
		t.Errorf("read back %+v %v", read, err)
	}
}

func TestWriteAtomic(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.md"), filepath.Join(dir, "sub", "b.md")
	if err := os.WriteFile(a, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(map[string][]byte{a: []byte("new a"), b: []byte("new b")}); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{a: "new a", b: "new b"} {
		if got, _ := os.ReadFile(p); string(got) != want {
			t.Errorf("%s = %q", p, got)
		}
	}
	// a file that cannot be renamed into place (a directory is in the way) leaves every file as it was
	blocker := filepath.Join(dir, "z.md")
	if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(map[string][]byte{a: []byte("newer a"), blocker: []byte("z")}); err == nil {
		t.Fatal("no error")
	}
	if got, _ := os.ReadFile(a); string(got) != "new a" {
		t.Errorf("a = %q after a failed write", got)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("temporary file left: %s", e.Name())
		}
	}
}
