package importer

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/Spreizu/wingman-spec/internal/config"
)

func TestDelta(t *testing.T) {
	in := "## ADDED Requirements\n\n### Requirement: A\nThe app SHALL a.\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: Old pager`\n- TO: `### Requirement: Paged list`\n"
	want := "## ADDED\n\n### Requirement: A\nThe app SHALL a.\n\n## RENAMED\n\n- Old pager -> Paged list\n"
	if got := Delta(in); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestImport(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"openspec/config.yaml":                           "schema: wingman-spec\ncontext: |\n  Facts.\n  - Test command: npm test\n  - Lint command: `npm run lint`\n  - Language/framework: TypeScript\ntraceability: warn\nvisual: off\n",
		"openspec/specs/notes/spec.md":                   "# notes Specification\n\n## Purpose\nP.\n\n## Requirements\n",
		"openspec/changes/add-tags/proposal.md":          "Size: S\nRisk: none\n\n## Why\nx\n",
		"openspec/changes/add-tags/.openspec.yaml":       "schema: wingman-spec\nskip_specs: true\n",
		"openspec/changes/add-tags/specs/tags/spec.md":   "## ADDED Requirements\n",
		"openspec/changes/archive/2026-01-02-x/tasks.md": "- [x] 1.1 a\n",
		"openspec/scripts/verify-task.cjs":               "//",
		"adr/0001-db.md":                                 "---\ntitle: DB\n---\n",
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := Build(dir, "openspec", ".wingman-spec")
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(dir, p); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{".wingman-spec/specs/notes.md", ".wingman-spec/changes/add-tags/specs/tags.md", ".wingman-spec/archive/2026-01-02-0000-x/tasks.md", ".wingman-spec/adrs/0001-db.md"} {
		if _, err := os.Stat(filepath.Join(dir, want)); err != nil {
			t.Errorf("missing %s", want)
		}
	}
	for _, gone := range []string{"openspec", "adr", ".wingman-spec/changes/add-tags/.openspec.yaml"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); err == nil {
			t.Errorf("%s still exists", gone)
		}
	}
	prop, _ := os.ReadFile(filepath.Join(dir, ".wingman-spec/changes/add-tags/proposal.md"))
	if !strings.Contains(string(prop), "Risk: none\nSpecs: none\n") {
		t.Errorf("proposal = %s", prop)
	}
	c, err := config.Load(filepath.Join(dir, ".wingman-spec/wingman-spec.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Commands.Test != "npm test" || c.Commands.Lint != "npm run lint" || c.Language != "TypeScript" || c.Traceability != "warn" || !c.Visual.Off || strings.Contains(c.Context, "Test command") {
		t.Errorf("config = %+v", c)
	}
}

// The floreas_docker import: a wrapped Test command bullet plus the template's own fact lines gave a duplicate
// `test` key, ui_files was a comma string and the old workflow boilerplate and default rules came along.
func TestConfigOldProject(t *testing.T) {
	text, warns, err := Config("testdata/floreas-config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "wingman-spec.yaml")
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := config.Load(p)
	if err != nil {
		t.Fatalf("%v\n%s", err, text)
	}
	if c.Commands.Test != "composer test" || c.Commands.Typecheck != "none" || c.Commands.Lint != "none" || !strings.HasPrefix(c.Language, "PHP 8.2, CodeIgniter 3.1.13") {
		t.Errorf("commands %+v, language %q", c.Commands, c.Language)
	}
	if strings.Count(text, "test: ") != 1 || !slices.Equal(c.Visual.UIFiles[:2], []string{"vue", "svelte"}) || len(c.Visual.UIFiles) != 13 || c.Visual.IgnoreHTTP[0] != "/catalog/image/" || c.AnchorMax != 3 {
		t.Errorf("config:\n%s", text)
	}
	for _, keep := range []string{"Project facts:\n- Product:", "- Language/framework: PHP 8.2", "  Do not edit CodeIgniter core", "- Test command: `composer test` (runs `composer test:php` then\n  `composer test:js`). PHP only", "  files, minify cache, or application logs.\n"} {
		if !strings.Contains(c.Context, keep) {
			t.Errorf("context lost %q:\n%s", keep, c.Context)
		}
	}
	for _, gone := range []string{"Workflow:", "COMMANDS:", "EXPLORE:", "SYNC:", "opsx", "openspec/", "verify-task", "<fill in>", "\n\n\n", "- Lint command"} {
		if strings.Contains(text, gone) {
			t.Errorf("%q left in:\n%s", gone, text)
		}
	}
	if strings.Contains(text, "rules:") || !slices.Contains(warns, "config.yaml: dropped 18 rules the old template wrote; 0.12 has them built in") {
		t.Errorf("rules kept or warnings %q", warns)
	}
}

func TestSplitContext(t *testing.T) {
	ctx, facts, warns := splitContext("Facts.\n- Test command: <fill in>\n# - Test run: <fill in>\n- Test command: `npm test` # all\n- Lint command: `npm run lint` (eslint)\n- Test command: npm run t\n")
	if ctx != "Facts.\n- Lint command: `npm run lint` (eslint)" || fmt.Sprint(facts) != "[[test npm test] [lint npm run lint]]" || len(warns) != 1 {
		t.Errorf("%q %v %q", ctx, facts, warns)
	}
}

func TestCustomRules(t *testing.T) {
	var n yaml.Node
	_ = yaml.Unmarshal([]byte("tasks:\n  - Cover happy path plus at least one error case.\n  - Run node openspec/scripts/verify-task.cjs lint before review.\nspecs:\n  - Size S writes only adrs/none.md.\n"), &n)
	var warns []string
	out, _ := yaml.Marshal(customRules(n.Content[0], &warns))
	if string(out) != "tasks:\n    - Run wingman-spec lint before review.\n" || len(warns) != 1 {
		t.Errorf("%s %q", out, warns)
	}
}
