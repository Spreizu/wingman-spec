package visual

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/spec"
)

// The ```visual block grammar (field list, steps, expect: and reference: syntax) is documented in docs/reference.md;
// visual/lib/visual-check.cjs runs the parsed scenarios in the browser.

// DefaultViewports are the widths a block without viewports: is checked at.
var DefaultViewports = []int{375, 768, 1280}

var (
	stepOps     = []string{"click", "fill", "press", "hover", "wait", "goto", "storage", "reload"}
	hideableOps = []string{"click", "hover"}
	relations   = []string{"left-with", "right-with", "top-with", "bottom-with", "center-with", "middle-with", "before", "above", "below", "left-of", "right-of", "same-row", "stacked", "same-width", "same-height", "inside", "gap-to"}
)

// Vps is a viewport filter (`@375`, `@375,768`, `@>=768`); Error is set when it cannot be read.
type Vps struct {
	Op    string `json:"op,omitempty"`
	Nums  []int  `json:"nums,omitempty"`
	Error string `json:"error,omitempty"`
}

// Match reports whether width vw passes the filter (a nil filter passes every width).
func (f *Vps) Match(vw int) bool {
	if f == nil || len(f.Nums) == 0 {
		return true
	}
	n := f.Nums[0]
	switch f.Op {
	case "<":
		return vw < n
	case "<=":
		return vw <= n
	case ">":
		return vw > n
	case ">=":
		return vw >= n
	}
	return slices.Contains(f.Nums, vw)
}

// Expect is one expect: line (a style fact or a relation between two elements).
type Expect struct {
	Raw   string  `json:"raw"`
	Vps   *Vps    `json:"vps"`
	Kind  string  `json:"kind,omitempty"`
	Sel   string  `json:"sel,omitempty"`
	Prop  string  `json:"prop,omitempty"`
	Op    string  `json:"op,omitempty"`
	Value string  `json:"value,omitempty"`
	Rel   string  `json:"rel,omitempty"`
	Other string  `json:"other,omitempty"`
	Line  int     `json:"line,omitempty"`
	State *string `json:"state"`
	Error string  `json:"error,omitempty"`
}

// Selectors are the elements an expect names.
func (x Expect) Selectors() []string {
	switch {
	case x.Error != "":
		return nil
	case x.Kind == "rel":
		return []string{x.Sel, x.Other}
	}
	return []string{x.Sel}
}

// Crop is the part of a reference image to compare with.
type Crop struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Reference is one reference: line (a design image, optionally cropped and per viewport).
type Reference struct {
	Path  string `json:"path"`
	Crop  *Crop  `json:"crop"`
	Vps   *Vps   `json:"vps"`
	Error string `json:"error,omitempty"`
}

// Step is one do: line of a state.
type Step struct {
	Op     string  `json:"op"`
	Target string  `json:"target,omitempty"`
	Value  *string `json:"value,omitempty"`
	Strict bool    `json:"strict,omitempty"`
}

// State is one state of a scenario.
type State struct {
	Name    string   `json:"name"`
	Steps   []Step   `json:"steps"`
	Keys    []string `json:"keys"`
	Expects []Expect `json:"expects"`
	Absents []string `json:"absents"`
}

// Scenario is one ```visual block with the scenario and requirement it sits in.
type Scenario struct {
	ID           string      `json:"id"`
	Capability   string      `json:"capability"`
	Requirement  string      `json:"requirement"`
	Scenario     string      `json:"scenario"`
	ScenarioLine int         `json:"scenario_line"`
	StepsText    []string    `json:"steps_text"`
	File         string      `json:"file"`
	Line         int         `json:"line"`
	Route        string      `json:"route"`
	Component    string      `json:"component"`
	Viewports    []int       `json:"viewports"`
	Reference    string      `json:"reference"`
	References   []Reference `json:"references"`
	Expects      []Expect    `json:"expects"`
	Keys         []string    `json:"keys"`
	Overlays     []string    `json:"overlays"`
	Role         string      `json:"role"`
	Absents      []string    `json:"absents"`
	RedirectsTo  string      `json:"redirects_to"`
	Ignores      []string    `json:"ignores"`
	IgnoreHTTP   []string    `json:"ignore_http"`
	States       []State     `json:"states"`
	Errors       []string    `json:"errors"`
}

// AllKeys are the key selectors of the block and of its states.
func (s *Scenario) AllKeys() []string {
	out := slices.Clone(s.Keys)
	for _, st := range s.States {
		out = append(out, st.Keys...)
	}
	return out
}

var (
	reqRE      = regexp.MustCompile(`^###\s+Requirement:\s*(.*?)\s*$`)
	scenRE     = regexp.MustCompile(`^####\s+Scenario:\s*(.*?)\s*$`)
	headRE     = regexp.MustCompile(`^#{1,3}\s`)
	stepTextRE = regexp.MustCompile(`^\s*[-*]\s+\*\*(WHEN|THEN|AND|GIVEN|BUT)\*\*`)
	openRE     = regexp.MustCompile("^\\s*(`{3,}|~{3,})\\s*visual\\s*$")
	blankRE    = regexp.MustCompile(`^\s*(#.*)?$`)
	fieldRE    = regexp.MustCompile(`^(\s*)([a-z-]+):\s*(.*?)\s*$`)
	vpListRE   = regexp.MustCompile(`[,\s]+`)
	digitsRE   = regexp.MustCompile(`^[0-9]+$`)
	kebabRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	stepRE     = regexp.MustCompile(`^([a-z]+)(!?)\s*(.*)$`)
	vpsTailRE  = regexp.MustCompile(`\s+@\s*((?:[<>]=?)?\s*\d+(?:\s*,\s*\d+)*)\s*$`)
	vpsRE      = regexp.MustCompile(`^([<>]=?)?\s*(\d+(?:\s*,\s*\d+)*)$`)
	commaRE    = regexp.MustCompile(`\s*,\s*`)
	spaceRE    = regexp.MustCompile(`\s+`)
	relRE      = regexp.MustCompile(`^(.+?)\s+(` + strings.Join(relations, "|") + `)\s+(.+?)(?:\s+(~|=)\s+(\S+))?$`)
	styleRE    = regexp.MustCompile(`^(.+?)\s+([a-z][a-z-]*)\s*(!=|~|=)\s*(.+)$`)
	cropRE     = regexp.MustCompile(`#(\d+),(\d+),(\d+),(\d+)$`)
)

// ParseScenarios reads the ```visual blocks of the capability files <dir>/<capability>.md (README.md is not a capability).
func ParseScenarios(dir string) []*Scenario {
	es, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range es {
		if n := e.Name(); strings.HasSuffix(n, ".md") && n != "README.md" && e.Type().IsRegular() {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	var out []*Scenario
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		out = append(out, ParseSpec(string(b), filepath.Join(dir, n), strings.TrimSuffix(n, ".md"))...)
	}
	return out
}

// ParseSpec reads the ```visual blocks of one spec file, with the scenario and requirement each sits in.
func ParseSpec(text, file, capability string) []*Scenario {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var out []*Scenario
	req, scen, inScen, scenLine := "", "", false, 0
	var when []string
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if m := reqRE.FindStringSubmatch(l); m != nil {
			req, scen, inScen = m[1], "", false
			continue
		}
		if m := scenRE.FindStringSubmatch(l); m != nil {
			scen, inScen, scenLine, when = m[1], m[1] != "", i+1, nil
			continue
		}
		if headRE.MatchString(l) {
			scen, inScen = "", false
			continue
		}
		if inScen && stepTextRE.MatchString(l) {
			when = append(when, strings.TrimSpace(l))
		}
		f := openRE.FindStringSubmatch(l)
		if f == nil {
			continue
		}
		closeRE := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(f[1][:1]) + `{` + strconv.Itoa(len(f[1])) + `,}\s*$`)
		var body []string
		j := i + 1
		for j < len(lines) && !closeRE.MatchString(lines[j]) {
			body = append(body, lines[j])
			j++
		}
		s := parseBlock(body, i+2)
		s.File, s.Line, s.Capability, s.Requirement, s.Scenario = file, i+1, capability, req, scen
		s.ScenarioLine, s.StepsText = scenLine, append([]string{}, when...)
		name := scen
		if !inScen {
			s.Errors = append([]string{fmt.Sprintf("line %d: a visual block must sit inside a \"#### Scenario:\" block", i+1)}, s.Errors...)
			name = fmt.Sprintf("line-%d", i+1)
		}
		s.ID = capability + "/" + spec.Slug(name)
		out = append(out, s)
		i = j
	}
	return out
}

func newState(name string) State {
	return State{Name: name, Steps: []Step{}, Keys: []string{}, Expects: []Expect{}, Absents: []string{}}
}

func parseBlock(body []string, firstLine int) *Scenario {
	s := &Scenario{StepsText: []string{}, References: []Reference{}, Expects: []Expect{}, Keys: []string{}, Overlays: []string{}, Absents: []string{}, Ignores: []string{}, IgnoreHTTP: []string{}, States: []State{}, Errors: []string{}}
	bad := func(ln int, f string, a ...any) {
		s.Errors = append(s.Errors, fmt.Sprintf("line %d: ", ln)+fmt.Sprintf(f, a...))
	}
	st := -1
	for k, raw := range body {
		ln := firstLine + k
		if blankRE.MatchString(raw) {
			continue
		}
		m := fieldRE.FindStringSubmatch(raw)
		if m == nil {
			bad(ln, "expected \"key: value\", got \"%s\"", strings.TrimSpace(raw))
			continue
		}
		indented, key, val := m[1] != "", m[2], m[3]
		if indented && st < 0 {
			bad(ln, "indented \"%s:\" outside a state", key)
			continue
		}
		if !indented {
			st = -1
		}
		if indented {
			x := &s.States[st]
			switch key {
			case "do":
				if step, err := parseStep(val); err != "" {
					bad(ln, "%s", err)
				} else {
					x.Steps = append(x.Steps, step)
				}
			case "key":
				if val != "" {
					x.Keys = append(x.Keys, val)
				} else {
					bad(ln, "empty key selector")
				}
			case "expect":
				e := ParseExpect(val)
				name := x.Name
				e.Line, e.State = ln, &name
				x.Expects = append(x.Expects, e)
				s.Expects = append(s.Expects, e)
			case "absent":
				if val != "" {
					x.Absents = append(x.Absents, val)
				} else {
					bad(ln, "empty absent selector")
				}
			case "overlay", "route", "component", "viewports", "reference", "role", "redirects-to", "ignore", "ignore-http":
				extra := ""
				if key == "overlay" {
					extra = "; an overlay listed once covers every state"
				}
				bad(ln, "\"%s:\" belongs to the whole block, not to state \"%s\": un-indent it and put it above the first \"state:\" line (a state takes only do:, key: and expect:)%s", key, x.Name, extra)
			default:
				bad(ln, "unknown state field \"%s\" (do, key, expect, absent)", key)
			}
			continue
		}
		switch key {
		case "route":
			s.Route = val
		case "component":
			s.Component = val
		case "reference":
			r := ParseReference(val)
			if r.Error != "" {
				bad(ln, "%s", r.Error)
			}
			s.References = append(s.References, r)
			if s.Reference == "" {
				s.Reference = r.Path
			}
		case "viewports":
			var vs []int
			ok := true
			for _, x := range vpListRE.Split(val, -1) {
				if x == "" {
					continue
				}
				n, err := strconv.Atoi(x)
				if !digitsRE.MatchString(x) || err != nil || n < 240 || n > 3840 {
					ok = false
				}
				vs = append(vs, n)
			}
			if len(vs) == 0 || !ok {
				bad(ln, "viewports must be widths in px between 240 and 3840, e.g. \"375, 768, 1280\"")
			} else {
				s.Viewports = vs
			}
		case "key":
			if val != "" {
				s.Keys = append(s.Keys, val)
			} else {
				bad(ln, "empty key selector")
			}
		case "overlay":
			if val != "" {
				s.Overlays = append(s.Overlays, val)
			}
		case "role":
			switch {
			case s.Role != "":
				bad(ln, "one role per visual block (already \"%s\"): write one scenario per role", s.Role)
			case val != "anonymous" && !kebabRE.MatchString(val):
				bad(ln, "role must be a kebab-case name defined under visual.roles in wingman-spec.yaml, or \"anonymous\", got \"%s\"", val)
			default:
				s.Role = val
			}
		case "absent":
			if val != "" {
				s.Absents = append(s.Absents, val)
			} else {
				bad(ln, "empty absent selector")
			}
		case "redirects-to":
			if !strings.HasPrefix(val, "/") {
				bad(ln, "redirects-to must be a path starting with \"/\", got \"%s\"", val)
			} else {
				s.RedirectsTo = val
			}
		case "expect":
			e := ParseExpect(val)
			e.Line = ln
			s.Expects = append(s.Expects, e)
		case "ignore":
			if v, err := config.CheckIgnore(val); err != nil {
				bad(ln, "%v", err)
			} else if !slices.Contains(s.Ignores, v) {
				s.Ignores = append(s.Ignores, v)
			}
		case "ignore-http":
			if v, err := config.CheckIgnoreHTTP(val); err != nil {
				bad(ln, "%v", err)
			} else if !slices.Contains(s.IgnoreHTTP, v) {
				s.IgnoreHTTP = append(s.IgnoreHTTP, v)
			}
		case "state":
			if !kebabRE.MatchString(val) {
				bad(ln, "state name must be kebab-case, got \"%s\"", val)
				continue
			}
			if slices.ContainsFunc(s.States, func(x State) bool { return x.Name == val }) {
				bad(ln, "duplicate state \"%s\"", val)
			}
			s.States = append(s.States, newState(val))
			st = len(s.States) - 1
		default:
			bad(ln, "unknown field \"%s\" (route, component, viewports, reference, key, expect, overlay, role, absent, redirects-to, ignore, ignore-http, state)", key)
		}
	}
	switch {
	case s.Route == "":
		s.Errors = append(s.Errors, `missing "route:" (the path to open, e.g. "route: /")`)
	case !strings.HasPrefix(s.Route, "/"):
		s.Errors = append(s.Errors, fmt.Sprintf("route must start with \"/\", got \"%s\"", s.Route))
	}
	stateKeys, stateAbsents := false, false
	for _, x := range s.States {
		stateKeys = stateKeys || len(x.Keys) > 0
		stateAbsents = stateAbsents || len(x.Absents) > 0
	}
	if len(s.Keys) == 0 && !stateKeys && len(s.Absents) == 0 && !stateAbsents {
		s.Errors = append(s.Errors, `no "key:" selector: name the elements that must be visible (e.g. key: [data-testid="search"])`)
	}
	if len(s.States) == 0 {
		s.States = append(s.States, newState("default"))
	}
	if s.Viewports == nil {
		s.Viewports = slices.Clone(DefaultViewports)
	}
	return s
}

func parseStep(v string) (Step, string) {
	m := stepRE.FindStringSubmatch(v)
	if m == nil {
		return Step{}, "empty step"
	}
	op, rest, strict := m[1], strings.TrimSpace(m[3]), m[2] == "!"
	if !slices.Contains(stepOps, op) {
		return Step{}, fmt.Sprintf("unknown step \"%s\" (%s)", op, strings.Join(stepOps, ", "))
	}
	if strict && !slices.Contains(hideableOps, op) {
		return Step{}, fmt.Sprintf("only \"click!\" and \"hover!\" can be strict; \"%s!\" is not allowed", op)
	}
	if op == "reload" {
		return Step{Op: op}, ""
	}
	if rest == "" {
		return Step{}, fmt.Sprintf("step \"%s\" needs an argument", op)
	}
	if op == "fill" || op == "storage" {
		target, val, ok := strings.Cut(rest, " = ")
		if !ok {
			what := "key"
			if op == "fill" {
				what = "selector"
			}
			return Step{}, fmt.Sprintf("step \"%s\" needs \"<%s> = <value>\"", op, what)
		}
		return Step{Op: op, Target: strings.TrimSpace(target), Value: &val}, ""
	}
	if op == "wait" && !digitsRE.MatchString(rest) {
		return Step{}, `step "wait" needs milliseconds`
	}
	if op == "goto" && !strings.HasPrefix(rest, "/") {
		return Step{}, `step "goto" needs a path starting with "/"`
	}
	return Step{Op: op, Target: rest, Strict: strict}, ""
}

// parseVps reads a viewport filter without spaces ("375", "375,768", ">=768").
func parseVps(f string) *Vps {
	if f == "" {
		return nil
	}
	m := vpsRE.FindStringSubmatch(f)
	if m == nil {
		return &Vps{Error: fmt.Sprintf("bad viewport filter \"@%s\" (use @375, @375,768, @>=768 or @<768)", f)}
	}
	var nums []int
	for _, x := range commaRE.Split(m[2], -1) {
		n, _ := strconv.Atoi(x)
		nums = append(nums, n)
	}
	if m[1] != "" && len(nums) > 1 {
		return &Vps{Error: fmt.Sprintf("bad viewport filter \"@%s\"", f)}
	}
	op := m[1]
	if op == "" {
		op = "in"
	}
	return &Vps{Op: op, Nums: nums}
}

// cutVps splits a trailing viewport filter (" @375,768") off t.
func cutVps(t string) (string, *Vps) {
	loc := vpsTailRE.FindStringSubmatchIndex(t)
	if loc == nil {
		return t, nil
	}
	return strings.TrimSpace(t[:loc[0]]), parseVps(spaceRE.ReplaceAllString(t[loc[2]:loc[3]], ""))
}

// ParseExpect reads one expect: value: `<selector> <css-property> ~|=|!= <value>` or `<a> <relation> <b> [~|= <distance>]`.
func ParseExpect(raw string) Expect {
	e := Expect{Raw: strings.TrimSpace(raw)}
	t, vps := cutVps(e.Raw)
	if vps != nil {
		e.Vps = vps
		if vps.Error != "" {
			e.Error = vps.Error
			return e
		}
	}
	if m := relRE.FindStringSubmatch(t); m != nil {
		e.Kind, e.Sel, e.Rel, e.Other, e.Op, e.Value = "rel", strings.TrimSpace(m[1]), m[2], strings.TrimSpace(m[3]), m[4], m[5]
		if m[2] == "gap-to" && e.Value == "" {
			e.Error = fmt.Sprintf("\"gap-to\" needs a distance: \"%s gap-to %s ~ 24px\"", e.Sel, e.Other)
		}
		return e
	}
	if m := styleRE.FindStringSubmatch(t); m != nil {
		e.Kind, e.Sel, e.Prop, e.Op, e.Value = "style", strings.TrimSpace(m[1]), m[2], m[3], strings.TrimSpace(m[4])
		return e
	}
	e.Error = fmt.Sprintf("cannot read expect \"%s\": use \"<selector> <css-property> ~|=|!= <value>\" or \"<a> <%s|...> <b>\"", e.Raw, strings.Join(relations[:3], "|"))
	return e
}

// ParseReference reads one reference: value: `<path>[#x,y,w,h] [@viewports]`.
func ParseReference(v string) Reference {
	t, vps := cutVps(strings.TrimSpace(v))
	r := Reference{Vps: vps}
	if m := cropRE.FindStringSubmatchIndex(t); m != nil {
		n := func(k int) int { x, _ := strconv.Atoi(t[m[2*k]:m[2*k+1]]); return x }
		r.Crop = &Crop{X: n(1), Y: n(2), W: n(3), H: n(4)}
		t = t[:m[0]]
	}
	r.Path = t
	if vps != nil && vps.Error != "" {
		r.Error = vps.Error
	}
	return r
}
