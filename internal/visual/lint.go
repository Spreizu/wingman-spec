package visual

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/config"
)

// Problem is one lint finding about a visual block (file, line, scenario, kind, severity, text).
type Problem = map[string]any

func problem(s *Scenario, line int, kind, severity, text string) Problem {
	p := Problem{"file": s.File, "line": line, "scenario": s.ID, "kind": kind, "text": text}
	if severity != "" {
		p["severity"] = severity
	}
	return p
}

func relTo(root, f string) string {
	if r, err := filepath.Rel(root, f); err == nil {
		return r
	}
	return f
}

// ResolveReference finds a reference image relative to the change directory, the specs root, the code root or the spec
// file's directory ("" when it exists nowhere).
func ResolveReference(s *Scenario, ref, changeDir, root, codeRoot string) string {
	if ref == "" {
		return ""
	}
	for _, base := range []string{changeDir, root, codeRoot, filepath.Dir(s.File)} {
		if base == "" {
			continue
		}
		p := ref
		if !filepath.IsAbs(p) {
			p = filepath.Join(base, ref)
		}
		if _, err := os.Stat(p); err == nil {
			abs, _ := filepath.Abs(p)
			return abs
		}
	}
	return ""
}

var passwordRE = regexp.MustCompile(`(?i)type\s*=\s*["']?password|name\s*=\s*["']?(password|passwd|pass)\b|#(password|passwd)\b`)

// LintScenarios returns the problems a spec author must fix (block syntax, a missing reference image, an unknown role, a password
// in a step, duplicate ids).
func LintScenarios(scens []*Scenario, changeDir, root, codeRoot string, cfg config.Visual) []Problem {
	var out []Problem
	seen := map[string]bool{}
	for _, s := range scens {
		where := fmt.Sprintf("%s:%d", relTo(root, s.File), s.Line)
		add := func(text string) { out = append(out, problem(s, s.Line, "visual", "error", where+": "+text)) }
		for _, e := range s.Errors {
			add(e)
		}
		if len(s.References) > 1 {
			for _, r := range s.References[1:] {
				if ResolveReference(s, r.Path, changeDir, root, codeRoot) == "" {
					add(fmt.Sprintf("reference image \"%s\" not found (relative to the change directory, the specs root or the code root)", r.Path))
				}
			}
		}
		if s.Reference != "" && ResolveReference(s, s.Reference, changeDir, root, codeRoot) == "" {
			add(fmt.Sprintf("reference image \"%s\" not found (relative to the change directory, the specs root or the code root)", s.Reference))
		}
		if _, ok := cfg.Roles[s.Role]; s.Role != "" && s.Role != "anonymous" && !ok {
			{
				defined := ""
				if len(cfg.Roles) > 0 {
					var ks []string
					for k := range cfg.Roles {
						ks = append(ks, k)
					}
					slices.Sort(ks)
					defined = " (defined: " + strings.Join(ks, ", ") + ")"
				}
				add(fmt.Sprintf("role \"%s\" is not defined under visual.roles in wingman-spec.yaml%s", s.Role, defined))
			}
		}
		for _, st := range s.States {
			for _, step := range st.Steps {
				if step.Op == "fill" && passwordRE.MatchString(step.Target) {
					add("a step fills a password field; do not put credentials in a spec: define a role (visual.roles) and write `role: <name>`")
				}
			}
		}
		if seen[s.ID] {
			add(fmt.Sprintf("duplicate visual scenario id %s (scenario names must be unique per capability)", s.ID))
		}
		seen[s.ID] = true
	}
	return out
}

var (
	replacingState = regexp.MustCompile(`(^|-)(empty|no-?results?|no-?match(es)?|nothing|none|zero|error|errors|invalid|failed|failure|cleared|filtered|offline)(-|$)`)
	positional     = regexp.MustCompile(`:(nth-(?:last-)?(?:child|of-type)\(\s*(\d+)?[^)]*\)|last-child|last-of-type)`)
	nonSlugRE      = regexp.MustCompile(`(?i)[^a-z0-9-]+`)
)

// ExpectScopeLint finds the block-level expects that a state probably removes the elements of. Block-level expect: lines are checked
// on the loaded page only, so such a state does not inherit them; the hint says which states skip which facts. "Removes" =
// the expect names a positional element (:nth-child(2), :last-child, ...) and the state's steps change the content, or the
// state is an empty/no-match/error state and the expect names an element that is not a block-level key.
func ExpectScopeLint(scens []*Scenario, root string) []Problem {
	var out []Problem
	for _, s := range scens {
		if len(s.Errors) > 0 {
			continue
		}
		blockKeys := map[string]bool{}
		for _, k := range s.Keys {
			blockKeys[strings.TrimSpace(k)] = true
		}
		for _, x := range s.Expects {
			if x.State != nil || x.Error != "" {
				continue
			}
			sels := x.Selectors()
			pos := false
			for _, sel := range sels {
				for _, m := range positional.FindAllStringSubmatch(sel, -1) {
					n, _ := strconv.Atoi(m[2])
					if m[2] == "" || n >= 2 || strings.Contains(m[1], "last") {
						pos = true
					}
				}
			}
			var nonKey []string
			for _, sel := range sels {
				if !blockKeys[strings.TrimSpace(sel)] {
					nonKey = append(nonKey, sel)
				}
			}
			var skipped []string
			for _, st := range s.States {
				if len(st.Steps) == 0 {
					continue
				}
				changes := slices.ContainsFunc(st.Steps, func(y Step) bool { return slices.Contains([]string{"fill", "click", "storage", "goto"}, y.Op) })
				replacing := replacingState.MatchString(st.Name) || slices.ContainsFunc(st.Keys, func(k string) bool {
					return replacingState.MatchString(strings.ToLower(nonSlugRE.ReplaceAllString(k, "-")))
				})
				switch {
				case pos && changes:
					skipped = append(skipped, st.Name+" (its steps change the content, so a positional element may be gone)")
				case len(nonKey) > 0 && replacing:
					skipped = append(skipped, fmt.Sprintf("%s (an empty/no-match/error state may remove %s)", st.Name, strings.Join(nonKey, ", ")))
				}
			}
			if len(skipped) > 0 {
				line := x.Line
				if line == 0 {
					line = s.Line
				}
				out = append(out, problem(s, line, "visual-expect-scope", "info", fmt.Sprintf("%s:%d: block-level expect \"%s\" is checked on the loaded page only, not in state %s. If it must also hold there, repeat it indented under that `state:` with elements that state shows; a block-level key: still applies to every state", relTo(root, s.File), line, x.Raw, strings.Join(skipped, "; "))))
			}
		}
	}
	return out
}

// NeedsDesignLint reports whether the design lint (design map, tokens: the helper's design-lint) has anything to look at.
func NeedsDesignLint(scens []*Scenario) bool {
	for _, s := range scens {
		if len(s.References) > 0 || len(s.Expects) > 0 {
			return true
		}
	}
	return false
}
