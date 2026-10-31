// Package importer converts an OpenSpec-based Wingman Spec project (openspec/ plus a root adr/) to the 0.12 layout.
// It is a one-shot move; nothing at runtime reads the old layout.
package importer

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/Spreizu/wingman-spec/internal/config"
)

// Step is one planned file operation.
type Step struct {
	Op   string `json:"op"` // move, write, remove
	From string `json:"from,omitempty"`
	To   string `json:"to"`
	text string
}

// Plan is the whole import, relative to the project directory.
type Plan struct {
	Steps    []Step   `json:"steps"`
	Warnings []string `json:"warnings"`
}

var (
	legacyHeading = regexp.MustCompile(`(?m)^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)[ \t]+Requirements[ \t]*$`)
	renameFrom    = regexp.MustCompile("(?i)^\\s*[-*]?\\s*FROM:\\s*`?(?:###\\s*Requirement:\\s*)?(.*?)`?\\s*$")
	renameTo      = regexp.MustCompile("(?i)^\\s*[-*]?\\s*TO:\\s*`?(?:###\\s*Requirement:\\s*)?(.*?)`?\\s*$")
	datedArchive  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})-(.+)$`)
	hhmm          = regexp.MustCompile(`^\d{4}-`)
	nestedSpec    = regexp.MustCompile(`^specs/([^/]+)/spec\.md$`)
	skipSpecs     = regexp.MustCompile(`(?m)^skip_specs:\s*true\s*$`)
	riskLine      = regexp.MustCompile(`(?m)^Risk:.*$`)
	contextFact   = regexp.MustCompile(`^(\s*)-\s*(Test command|Typecheck command|Lint command|Language/framework|Test run|Check level|Targeted test command):\s*(.*?)\s*$`)
	// paragraphs and comments the old config templates wrote into context; 0.12 has that workflow built in
	boilerplate = regexp.MustCompile("^(Workflow:|COMMANDS:|EXPLORE:|SYNC:|Project facts \\(edit me\\)|`?(node )?(openspec/scripts/)?verify-task\\.cjs`? runs)")
	blankRun    = regexp.MustCompile(`\n\s*\n(\s*\n)+`)
	tmplComment = regexp.MustCompile(`^\s*#(\s+-|\s\s)`)
	oldPaths    = strings.NewReplacer("openspec/specs/", "specs/", "openspec/changes/", "changes/", "openspec/config.yaml", "wingman-spec.yaml", "node openspec/scripts/verify-task.cjs", "wingman-spec", "openspec/scripts/verify-task.cjs", "wingman-spec", "verify-task.cjs", "wingman-spec")
	// the rules the old templates wrote (by their first words); 0.12 builds them into the artifact instructions
	builtinRules = []string{`A "## Intents" section`, `An "## Edge cases" section`, "Code anchors: put a comment", "Each task needs Spec, Test first, Files and Done when",
		"Every requirement carries a line", "Every requirement that computes, transforms", `Line 1 is "Size: S|M|L"`, "No Size line in tasks.md", "Size S (see the proposal rules)",
		"Size S: only", `Start with a "Size: S|M|L" line`, `Under each SHALL sentence, one line "Why:`, "With a design input, visual scenarios", "A review task may fix findings",
		"A task that builds or changes UI names its visual scenarios", "Cover happy path plus at least one", "Every scenario must use concrete inputs",
		"Every user-visible UI behavior gets a visual scenario", "List ADR candidates for every", "Size S writes only adrs/none.md", "Test titles carry the scenario id",
		"With a design-map.md, Files lines follow the map"}
)

// Delta rewrites an OpenSpec delta spec: short section headings, `- Old -> New` renames.
func Delta(src string) string {
	src = legacyHeading.ReplaceAllString(src, "## $1")
	lines := strings.Split(src, "\n")
	var out []string
	from := ""
	section := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "## ") {
			section = strings.TrimSpace(l[3:])
		}
		if section == "RENAMED" {
			if m := renameFrom.FindStringSubmatch(l); m != nil {
				from = m[1]
				continue
			}
			if m := renameTo.FindStringSubmatch(l); m != nil && from != "" {
				out = append(out, fmt.Sprintf("- %s -> %s", from, m[1]))
				from = ""
				continue
			}
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// Build plans the import of dir/openspec into dest (relative to dir), e.g. ".wingman-spec".
func Build(dir, old, dest string) (*Plan, error) {
	src := filepath.Join(dir, old)
	if st, err := os.Stat(src); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("no %s/ folder in %s", old, dir)
	}
	if _, err := os.Stat(filepath.Join(dir, dest, "wingman-spec.yaml")); err == nil {
		return nil, fmt.Errorf("%s/wingman-spec.yaml exists: this project is imported already", dest)
	}
	p := &Plan{Steps: []Step{}, Warnings: []string{}}
	rel := func(parts ...string) string { return filepath.ToSlash(filepath.Join(parts...)) }

	// living specs
	caps, _ := filepath.Glob(filepath.Join(src, "specs", "*", "spec.md"))
	for _, c := range caps {
		name := filepath.Base(filepath.Dir(c))
		b, err := os.ReadFile(c)
		if err != nil {
			return nil, err
		}
		p.Steps = append(p.Steps, Step{Op: "write", From: rel(old, "specs", name, "spec.md"), To: rel(dest, "specs", name+".md"), text: string(b)})
	}
	// changes and archive
	ents, _ := os.ReadDir(filepath.Join(src, "changes"))
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		if e.Name() == "archive" {
			arch, _ := os.ReadDir(filepath.Join(src, "changes", "archive"))
			for _, a := range arch {
				if !a.IsDir() {
					continue
				}
				name := a.Name()
				if m := datedArchive.FindStringSubmatch(name); m != nil && !hhmm.MatchString(m[2]) {
					name = m[1] + "-0000-" + m[2]
				}
				if err := planChange(p, dir, rel(old, "changes", "archive", a.Name()), rel(dest, "archive", name)); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := planChange(p, dir, rel(old, "changes", e.Name()), rel(dest, "changes", e.Name())); err != nil {
			return nil, err
		}
	}
	// ADRs promoted to the repository root
	adrs, _ := filepath.Glob(filepath.Join(dir, "adr", "*.md"))
	for _, a := range adrs {
		b, err := os.ReadFile(a)
		if err != nil {
			return nil, err
		}
		text := string(b)
		if filepath.Base(a) == "README.md" {
			text = oldPaths.Replace(text)
		}
		p.Steps = append(p.Steps, Step{Op: "write", From: rel("adr", filepath.Base(a)), To: rel(dest, "adrs", filepath.Base(a)), text: text})
	}
	// other folders the planning workflow keeps (roadmap, greenfield records, glossary)
	for _, extra := range []string{"roadmap", "greenfield", "glossary.md", "design-system.md"} {
		if _, err := os.Stat(filepath.Join(src, extra)); err == nil {
			p.Steps = append(p.Steps, Step{Op: "move", From: rel(old, extra), To: rel(dest, extra)})
		}
	}
	// config
	cfg, warns, err := Config(filepath.Join(src, "config.yaml"))
	if err != nil {
		return nil, err
	}
	p.Warnings = append(p.Warnings, warns...)
	p.Steps = append(p.Steps, Step{Op: "write", From: rel(old, "config.yaml"), To: rel(dest, "wingman-spec.yaml"), text: cfg})
	if _, err := os.Stat(filepath.Join(src, "workspace.yaml")); err == nil {
		p.Warnings = append(p.Warnings, old+"/workspace.yaml: set `specs: <relative path to the specs repo>` in wingman-spec.yaml by hand (the store registry is gone)")
	}
	known := []string{"specs", "changes", "config.yaml", "scripts", "workspace.yaml", "roadmap", "greenfield", "glossary.md", "design-system.md", ".local", ".gitignore"}
	var unknown []string
	tops, _ := os.ReadDir(src)
	for _, t := range tops {
		if !slices.Contains(known, t.Name()) {
			unknown = append(unknown, t.Name())
		}
	}
	if len(unknown) > 0 {
		p.Warnings = append(p.Warnings, fmt.Sprintf("%s/ is kept: it also holds %s; move what you need and delete it", old, strings.Join(unknown, ", ")))
	} else {
		p.Steps = append(p.Steps, Step{Op: "remove", To: old})
	}
	if len(adrs) > 0 {
		p.Steps = append(p.Steps, Step{Op: "remove", To: "adr"})
	}
	return p, nil
}

func planChange(p *Plan, dir, from, to string) error {
	root := filepath.Join(dir, from)
	skip := false
	if b, err := os.ReadFile(filepath.Join(root, ".openspec.yaml")); err == nil && skipSpecs.Match(b) {
		skip = true
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		r, _ := filepath.Rel(root, path)
		r = filepath.ToSlash(r)
		if r == ".openspec.yaml" {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text, target := string(b), r
		if m := nestedSpec.FindStringSubmatch(r); m != nil {
			target, text = "specs/"+m[1]+".md", Delta(text)
		}
		if r == "proposal.md" && skip && !strings.Contains(text, "Specs: none") {
			if loc := riskLine.FindStringIndex(text); loc != nil {
				text = text[:loc[1]] + "\nSpecs: none" + text[loc[1]:]
			} else {
				text = "Specs: none\n" + text
			}
		}
		if strings.HasSuffix(r, ".md") {
			text = oldPaths.Replace(text)
		}
		p.Steps = append(p.Steps, Step{Op: "write", From: filepath.ToSlash(filepath.Join(from, r)), To: filepath.ToSlash(filepath.Join(to, target)), text: text})
		return nil
	})
}

var keepKeys = []string{"traceability", "anchor_placement", "anchor_guard", "anchor_fit", "anchor_max", "anchor_many", "test_evidence", "anchor_stale", "visual", "rules"}

// Config converts an OpenSpec config.yaml to wingman-spec.yaml text. The project facts of `context:`
// (`- Test command: ...`) become `commands:` and `language:`.
func Config(path string) (string, []string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "commands:\n  test: <fill in>\n", []string{"no config.yaml: wrote a minimal wingman-spec.yaml"}, nil
	}
	if err != nil {
		return "", nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return "", nil, fmt.Errorf("%s: %w", path, err)
	}
	var warns []string
	out := &yaml.Node{Kind: yaml.MappingNode}
	add := func(k string, v *yaml.Node) {
		out.Content = append(out.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: k}, v)
	}
	str := func(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Value: s} }
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return "", nil, fmt.Errorf("%s: not a map of keys", path)
	}
	m := doc.Content[0]
	get := func(k string) *yaml.Node {
		for i := 0; i+1 < len(m.Content); i += 2 {
			if m.Content[i].Value == k {
				return m.Content[i+1]
			}
		}
		return nil
	}
	if c := get("context"); c != nil {
		ctx, facts, w := splitContext(c.Value)
		warns = append(warns, w...)
		if ctx = oldPaths.Replace(ctx); ctx != "" {
			n := str(ctx + "\n")
			n.Style = yaml.LiteralStyle
			add("context", n)
		}
		cmds, lang := &yaml.Node{Kind: yaml.MappingNode}, ""
		for _, f := range facts {
			if f[0] == "language" {
				lang = f[1]
			} else {
				cmds.Content = append(cmds.Content, str(f[0]), str(f[1]))
			}
		}
		if len(cmds.Content) > 0 {
			add("commands", cmds)
		}
		if lang != "" && lang != config.Placeholder {
			add("language", str(lang))
		}
	}
	for _, k := range keepKeys {
		v := get(k)
		switch {
		case v == nil:
		case k == "visual":
			config.CommaLists(v)
			add(k, v)
		case k == "rules":
			if n := customRules(v, &warns); n != nil {
				add(k, n)
			}
		default:
			add(k, v)
		}
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		k := m.Content[i].Value
		if k != "schema" && k != "context" && !slices.Contains(keepKeys, k) {
			warns = append(warns, fmt.Sprintf("config.yaml: key %q is not used by wingman-spec.yaml; it was dropped", k))
		}
	}
	text, err := yaml.Marshal(out)
	return string(text), warns, err
}

// Apply runs the plan in dir: every write first, then the removals.
func Apply(dir string, p *Plan) error {
	for _, s := range p.Steps {
		to := filepath.Join(dir, filepath.FromSlash(s.To))
		switch s.Op {
		case "write":
			if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(to, []byte(s.text), 0o644); err != nil {
				return err
			}
		case "move":
			if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
				return err
			}
			if err := os.Rename(filepath.Join(dir, filepath.FromSlash(s.From)), to); err != nil {
				return err
			}
		}
	}
	for _, s := range p.Steps {
		if s.Op == "remove" {
			if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(s.To))); err != nil {
				return err
			}
		}
	}
	return nil
}

// factKeys maps the old context fact bullets to their wingman-spec.yaml keys.
var factKeys = map[string]string{"Test command": "test", "Typecheck command": "typecheck", "Lint command": "lint", "Test run": "test_run", "Check level": "check_level", "Targeted test command": "targeted", "Language/framework": "language"}

// splitContext drops the old template boilerplate from context and takes out the command facts. A fact bullet that
// is only a value is removed; one with more prose (or wrapped lines) stays whole and gives its first `command`. The
// first real value of a fact wins, so a fact written twice never becomes a duplicate key.
func splitContext(ctx string) (string, [][2]string, []string) {
	var keep []string
	var facts [][2]string
	var warns []string
	lines := strings.Split(ctx, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if boilerplate.MatchString(strings.TrimSpace(line)) {
			for i+1 < len(lines) && strings.TrimSpace(lines[i+1]) != "" && !strings.HasPrefix(lines[i+1], "- ") {
				i++
			}
			continue
		}
		if tmplComment.MatchString(line) {
			continue
		}
		f := contextFact.FindStringSubmatch(line)
		if f == nil {
			keep = append(keep, line)
			continue
		}
		end := i + 1 // wrapped lines are indented deeper than the dash
		for end < len(lines) && strings.TrimSpace(lines[end]) != "" && len(lines[end])-len(strings.TrimLeft(lines[end], " \t")) > len(f[1]) {
			end++
		}
		v, prose := strings.TrimSpace(strings.SplitN(f[3], " #", 2)[0]), end > i+1
		if k := factKeys[f[2]]; k != "language" && strings.HasPrefix(v, "`") {
			if j := strings.Index(v[1:], "`"); j >= 0 {
				prose = prose || strings.TrimSpace(v[j+2:]) != ""
				v = v[1 : j+1]
			}
		}
		v = strings.Trim(v, "`")
		if prose {
			keep = append(keep, lines[i:end]...)
		}
		i = end - 1
		k := factKeys[f[2]]
		at := slices.IndexFunc(facts, func(x [2]string) bool { return x[0] == k })
		switch {
		case v == "":
		case at < 0:
			facts = append(facts, [2]string{k, v})
		case facts[at][1] == config.Placeholder:
			facts[at][1] = v
		case facts[at][1] != v && v != config.Placeholder:
			warns = append(warns, fmt.Sprintf("config.yaml: context names two values for %s (%q and %q); kept the first", f[2], facts[at][1], v))
		}
	}
	out := blankRun.ReplaceAllString(strings.Join(keep, "\n"), "\n\n")
	return strings.TrimSpace(out), facts, warns
}

// customRules keeps the project's own rules (with old paths rewritten) and drops the defaults the old templates
// wrote, which 0.12 builds in. Nil when none are left.
func customRules(rules *yaml.Node, warns *[]string) *yaml.Node {
	if rules.Kind != yaml.MappingNode {
		return rules
	}
	out, dropped := &yaml.Node{Kind: yaml.MappingNode}, 0
	for i := 0; i+1 < len(rules.Content); i += 2 {
		list := rules.Content[i+1]
		if list.Kind != yaml.SequenceNode {
			out.Content = append(out.Content, rules.Content[i], list)
			continue
		}
		kept := &yaml.Node{Kind: yaml.SequenceNode}
		for _, r := range list.Content {
			if slices.ContainsFunc(builtinRules, func(p string) bool { return strings.HasPrefix(r.Value, p) }) {
				dropped++
				continue
			}
			r.Value = oldPaths.Replace(r.Value)
			kept.Content = append(kept.Content, r)
		}
		if len(kept.Content) > 0 {
			out.Content = append(out.Content, rules.Content[i], kept)
		}
	}
	if dropped > 0 {
		*warns = append(*warns, fmt.Sprintf("config.yaml: dropped %d rules the old template wrote; 0.12 has them built in", dropped))
	}
	if len(out.Content) == 0 {
		return nil
	}
	return out
}
