package quality

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func errorsOf(fs []Finding) int {
	n := 0
	for _, f := range fs {
		if f.Severity == "error" {
			n++
		}
	}
	return n
}

// A UI edge case maps to the visual state that shows it; numbers and short words count as tokens.
func TestEdgeLintUIState(t *testing.T) {
	d := t.TempDir()
	write(t, filepath.Join(d, "proposal.md"), "## Why\nApp change.\n\n## What Changes\n- A change.\n\n## Edge cases\n- The badge with 1 item is not truncated at 375 -> app/search\n")
	write(t, filepath.Join(d, "specs", "app.md"), "## ADDED\n\n### Requirement: App\nThe system SHALL work.\n\n#### Scenario: Search\n- **WHEN** the query is typed\n- **THEN** the grid filters\n")
	state := func(name string) map[string]VisualScenario {
		return map[string]VisualScenario{"app/search": {States: []VisualState{
			{Name: "default"},
			{Name: name, Steps: []any{map[string]any{"op": "storage", "target": "items", "value": "x"}}},
		}}}
	}
	for _, tc := range []struct {
		state string
		want  int
	}{{"one-item", 0}, {"many-items", 1}} {
		_, fs := EdgeLint(d, "", state(tc.state), false)
		if got := errorsOf(fs); got != tc.want {
			t.Errorf("state %s: %d errors, want %d: %+v", tc.state, got, tc.want, fs)
		}
	}
}

// A UI change whose visual blocks were all dropped still needs a state per UI edge case, and a page-element scenario
// without a block warns; a `Not visual: <reason>` line answers both.
func TestDroppedVisualBlocks(t *testing.T) {
	d := t.TempDir()
	write(t, filepath.Join(d, "proposal.md"), "## Why\nApp change.\n\n## What Changes\n- A change.\n\n## Edge cases\n- Empty cart shows a hint -> app/empty-cart\n")
	scen := "## ADDED\n\n### Requirement: App\nThe system SHALL work.\n\n#### Scenario: Empty cart\n- **WHEN** the cart has no lines\n- **THEN** `[data-testid=\"hint\"]` is shown\n"
	for _, tc := range []struct {
		extra      string
		ui         bool
		errs, warn int
	}{{"", true, 1, 1}, {"", false, 0, 0}, {"\nNot visual: the live account has lines; covered by CartTest\n", true, 0, 0}} {
		write(t, filepath.Join(d, "specs", "app.md"), scen+tc.extra)
		_, fs := EdgeLint(d, "", nil, tc.ui)
		if got := errorsOf(fs); got != tc.errs {
			t.Errorf("ui=%v extra=%q: %d edge errors, want %d: %+v", tc.ui, tc.extra, got, tc.errs, fs)
		}
		if got := len(VisualGapLint(d, tc.ui)); got != tc.warn {
			t.Errorf("ui=%v extra=%q: %d visual-gap warnings, want %d", tc.ui, tc.extra, got, tc.warn)
		}
	}
}

// The source-text detector follows a path through a variable or path.join and ignores data fixtures.
func TestSourceTextFindings(t *testing.T) {
	d := t.TempDir()
	for _, tc := range []struct {
		name, body, want string
	}{
		{"a.test.ts", "import { readFileSync } from 'node:fs';\nconst file = 'src/lib/discount.ts';\ntest('[demo/greet] x', () => {\n  const t = readFileSync(file, 'utf8');\n});\n", "reads src/lib/discount.ts"},
		{"b.test.ts", "import { readFileSync } from 'node:fs';\ntest('[demo/greet] x', () => {\n  const d = JSON.parse(readFileSync('./fixtures/data.json', 'utf8'));\n});\n", ""},
		{"c.test.ts", "import fs from 'node:fs/promises'; import path from 'node:path';\ntest('[demo/greet] x', async () => {\n  const t = await fs.readFile(path.join(__dirname, '..', 'src', 'components', 'List.vue'), 'utf8');\n});\n", "reads List.vue"},
	} {
		f := filepath.Join(d, tc.name)
		write(t, f, tc.body)
		got, _ := SourceTextFindings(f, "t")
		switch {
		case tc.want == "" && len(got) > 0:
			t.Errorf("%s: want no finding, got %+v", tc.name, got)
		case tc.want != "" && (len(got) == 0 || !strings.Contains(got[0].Text, tc.want)):
			t.Errorf("%s: want %q, got %+v", tc.name, tc.want, got)
		}
	}
}
