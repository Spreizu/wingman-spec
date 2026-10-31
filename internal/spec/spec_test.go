package spec

import (
	"errors"
	"strings"
	"testing"
)

const living = `# demo

## Purpose
Greets people.

## Requirements

### Requirement: Greet
The system SHALL greet.

#### Scenario: hello
- **WHEN** asked
- **THEN** it says hello

### Requirement: Old pager
The system SHALL page.

#### Scenario: page
- **WHEN** scrolled
- **THEN** it pages

## Notes
kept as is
`

func TestMerge(t *testing.T) {
	delta := ParseDelta("## RENAMED\n- Greet -> Greeting\n\n## REMOVED\n### Requirement: Old pager\nReason: replaced\n\n" +
		"## MODIFIED\n### Requirement: Greeting\nThe system SHALL greet by name.\n\n#### Scenario: hello\n- **WHEN** Ann asks\n- **THEN** it says `Hello Ann`\n\n" +
		"## ADDED\n### Requirement: Wave\nThe system SHALL wave.\n\n#### Scenario: wave\n- **WHEN** seen\n- **THEN** it waves\n\n```visual\n### not a heading\n```\n")
	if len(delta.Problems) > 0 {
		t.Fatalf("delta problems: %v", delta.Problems)
	}
	got, err := Merge("demo", living, delta)
	if err != nil {
		t.Fatal(err)
	}
	want := `# demo

## Purpose
Greets people.

## Requirements

### Requirement: Greeting
The system SHALL greet by name.

#### Scenario: hello
- **WHEN** Ann asks
- **THEN** it says ` + "`Hello Ann`" + `

### Requirement: Wave
The system SHALL wave.

#### Scenario: wave
- **WHEN** seen
- **THEN** it waves

` + "```visual\n### not a heading\n```" + `

## Notes
kept as is
`
	if got != want {
		t.Errorf("merge:\n%s\nwant:\n%s", got, want)
	}
	// Merging is deterministic and a re-parse round-trips.
	if again := ParseLiving(got).Render(); again != got {
		t.Errorf("render is not stable:\n%s", again)
	}
}

func TestMergeConflicts(t *testing.T) {
	tests := []struct{ name, delta, want string }{
		{"modify missing", "## MODIFIED\n### Requirement: Nope\nThe system SHALL x.\n", `MODIFIED: no requirement "Nope"`},
		{"add existing", "## ADDED\n### Requirement: greet\nThe system SHALL x.\n", `ADDED: requirement "greet" already exists`},
		{"remove missing", "## REMOVED\n### Requirement: Nope\n", `REMOVED: no requirement "Nope"`},
		{"rename onto existing", "## RENAMED\n- Greet -> Old pager\n", `already exists`},
		{"legacy heading", "## ADDED Requirements\n### Requirement: X\nThe system SHALL x.\n", "write `## ADDED`"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Merge("demo", living, ParseDelta(tt.delta))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.want)
			}
			if _, ok := errors.AsType[*MergeError](err); !ok {
				t.Errorf("not a MergeError: %T", err)
			}
		})
	}
}

func TestMergeNewCapability(t *testing.T) {
	d := ParseDelta("## Purpose\nLists items.\n\n## ADDED\n### Requirement: List\nThe system SHALL list.\n\n#### Scenario: one\n- **WHEN** a\n- **THEN** b\n")
	got, err := Merge("items", "", d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "# items\n\n## Purpose\nLists items.\n\n## Requirements\n\n### Requirement: List\n") {
		t.Errorf("got:\n%s", got)
	}
	if got, err := Merge("items", "", ParseDelta("## ADDED\n### Requirement: L\nThe system SHALL l.\n")); err != nil || !strings.Contains(got, PurposePlaceholder) {
		t.Errorf("a new capability without ## Purpose: want the placeholder, got %v\n%s", err, got)
	}
	if _, err := Merge("items", "", ParseDelta("## MODIFIED\n### Requirement: L\nThe system SHALL l.\n")); err == nil {
		t.Error("MODIFIED on a new capability merged")
	}
}

func TestScenarios(t *testing.T) {
	d := ParseDelta("## ADDED\n### Requirement: A\nThe system SHALL a.\n\n#### Scenario: One\n- x\n\n#### Scenario: Two\n- y\n")
	if n := len(d.Added[0].Scenarios); n != 2 || d.Added[0].Scenarios[1].Name != "Two" || d.Added[0].Scenarios[1].Line != 8 {
		t.Fatalf("scenarios = %+v", d.Added[0].Scenarios)
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{"Three columns on a laptop": "three-columns-on-a-laptop", "  --X__y!! ": "x-y", "!!": "scenario"} {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSynced(t *testing.T) {
	living := "# c\n\n## Purpose\nThe purpose of this capability is described here in one sentence.\n\n## Requirements\n\n### Requirement: A\nThe app SHALL a.\n\n#### Scenario: S\n- x\n"
	d := ParseDelta("## ADDED\n\n### Requirement: B\nThe app SHALL b.\n\n#### Scenario: S\n- x\n\n## REMOVED\n\n### Requirement: A\nReason: gone\n")
	if p := Synced(living, d); len(p) != 2 {
		t.Fatalf("before merge: %v", p)
	}
	merged, err := Merge("c", living, d)
	if err != nil {
		t.Fatal(err)
	}
	if p := Synced(merged, d); len(p) != 0 {
		t.Errorf("after merge: %v", p)
	}
}
