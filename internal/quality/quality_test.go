package quality

import (
	"os"
	"path/filepath"
	"slices"
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

// A narrow-width edge case is shown by a narrow viewport of its block; it needs no state of its own.
func TestEdgeLintNarrowViewport(t *testing.T) {
	d := t.TempDir()
	write(t, filepath.Join(d, "proposal.md"), "## Why\nApp change.\n\n## What Changes\n- A change.\n\n## Edge cases\n- Narrow form at 375px -> app/search\n")
	write(t, filepath.Join(d, "specs", "app.md"), "## ADDED\n\n### Requirement: App\nThe system SHALL work.\n\n#### Scenario: Search\n- **WHEN** the query is typed\n- **THEN** the grid filters\n")
	for _, tc := range []struct {
		vp   []int
		want int
	}{{[]int{375}, 0}, {[]int{768, 1280}, 1}} {
		_, fs := EdgeLint(d, "", map[string]VisualScenario{"app/search": {States: []VisualState{{Name: "default"}}, Viewports: tc.vp}}, false)
		if got := errorsOf(fs); got != tc.want {
			t.Errorf("viewports %v: %d errors, want %d: %+v", tc.vp, got, tc.want, fs)
		}
	}
	write(t, filepath.Join(d, "proposal.md"), "## Why\nApp change.\n\n## What Changes\n- A change.\n\n## Edge cases\n- A long title wraps at 375 -> app/search\n")
	if _, fs := EdgeLint(d, "", map[string]VisualScenario{"app/search": {States: []VisualState{{Name: "default"}}, Viewports: []int{375}}}, false); errorsOf(fs) != 1 {
		t.Errorf("long text at 375 still needs a state: %+v", fs)
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

// A visual scenario with a non-default state needs design.md ## Testing approach (error), naming the scenario (warning).
func TestReachLint(t *testing.T) {
	dir := t.TempDir()
	vm := map[string]VisualScenario{
		"cart/empty":  {States: []VisualState{{Name: "empty"}}},
		"cart/plain":  {States: []VisualState{{Name: "default"}}},
		"cart/loaded": {States: []VisualState{{Name: "many items"}}},
	}
	if fs := ReachLint(dir, vm); fs != nil {
		t.Errorf("no design.md (fast path): want nothing, got %v", fs)
	}
	write(t, filepath.Join(dir, "design.md"), "## Decisions\nOne.\n")
	if fs := ReachLint(dir, vm); errorsOf(fs) != 1 || !strings.Contains(fs[0].Text, "cart/empty, cart/loaded") || strings.HasPrefix(fs[0].Text, "design.md") {
		t.Errorf("no Testing approach: want one error naming both scenarios, got %v", fs)
	}
	write(t, filepath.Join(dir, "design.md"), "## Decisions\nOne.\n\n## Testing approach\nThe empty cart comes from the seed route.\n")
	fs := ReachLint(dir, vm)
	if len(fs) != 1 || fs[0].Severity != "warning" || fs[0].Line != 4 || !strings.Contains(fs[0].Text, "cart/loaded") {
		t.Errorf("want one warning for cart/loaded at line 4, got %v", fs)
	}
	if fs := ReachLint(dir, map[string]VisualScenario{"cart/plain": vm["cart/plain"]}); fs != nil {
		t.Errorf("only default states: want nothing, got %v", fs)
	}
}

// test_files globs add files the built-in detection misses (** matches no directory too); a !glob drops files.
func TestListTestFilesGlobs(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"src/a.test.js", "checks/flow.js", "checks/deep/more.js", "src/a.js", "tests/fixture/data.js", "e2e1.js"} {
		write(t, filepath.Join(dir, f), "x\n")
	}
	got := ListTestFiles(dir, []string{"checks/**/*.js", "e2e?.js", "!tests/fixture/**"})
	slices.Sort(got)
	want := []string{"checks/deep/more.js", "checks/flow.js", "e2e1.js", "src/a.test.js"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got := ListTestFiles(dir, nil); !slices.Contains(got, "tests/fixture/data.js") || slices.Contains(got, "checks/flow.js") {
		t.Errorf("without globs: the built-in detection only, got %v", got)
	}
}
