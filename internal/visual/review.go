package visual

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// RubricItems are the design-match items a reviewer judges for a scenario with a design reference.
var RubricItems = []string{"layout", "hierarchy", "spacing", "colour", "typography", "components"}

var rubric = []string{
	"Judge only what the images and the ARIA diff show, against the scenario text (WHEN/THEN), its visual block and the design reference (if any).",
	"Each pair is the SAME area (the box around the scenario's key elements) before the task and after it. \"Before\" may be empty or unrelated when the task builds the area from scratch.",
	"1. The change from before to after is the one the scenario asks for, and only that: nothing in the area got worse (spacing, alignment, text, icons, colours) that the scenario did not ask to change.",
	"2. Layout: the arrangement the scenario states (columns, order, alignment, which panel is where) holds at every viewport.",
	"3. Nothing is clipped, cut off, squashed, overlapping or pushed off-screen; long text wraps instead of overflowing.",
	"4. The state is the one the scenario describes (e.g. the empty-state message is shown, the drawer is open, the count is right).",
	"5. Text is readable: sensible size, contrast and line length; no placeholder, debug or \"undefined\"/\"NaN\" text.",
	"6. Spacing and alignment are consistent; interactive elements look interactive and are large enough to tap on 375px.",
	"7. With a design reference: hierarchy, layout and colours match it closely enough that a designer would not file a bug.",
	"Report only concrete, visible defects with the scenario, state and viewport, what is wrong and what is expected (e.g. \"button overlaps header at 375px\"). No taste nitpicks, no code advice. If nothing is wrong, pass.",
}

var designRubric = []string{
	"Design match (each scenario with a design reference). Open its side-by-side images (left: the rendered area after the task, right: the design reference) and judge each item; cite what you compared (which elements, where, what you saw on each side):",
	"  layout: arrangement, columns, order, alignment and relative sizes of the regions at this viewport.",
	"  hierarchy: what reads as most to least prominent (headings, prices, primary action, highlighted item).",
	"  spacing: gaps between and padding inside the regions follow the design rhythm (not pixel-exact).",
	"  colour: fills, text, borders and the accent/highlight use the same colours (same tokens) as the design.",
	"  typography: sizes, weights, case and letter-spacing of the text styles match the design.",
	"  components: the same kinds of components and variants (buttons, cards, badges, inputs, switches) as the design.",
	"Write one line per item and scenario: RUBRIC: <scenario id> <item>: pass|fail - <citation>. A fail also needs a DEFECT line. Not pixel-perfect: fail only what a designer would file as \"does not match the design\".",
}

// Pair is one before/after area image pair of a task scenario (from the visual report).
type Pair struct {
	Scenario   string `json:"scenario"`
	State      string `json:"state"`
	Viewport   int    `json:"viewport"`
	Before     string `json:"before"`
	After      string `json:"after"`
	SideBySide string `json:"side_by_side"`
}

// AriaChange is one change of the ARIA structure of a scenario's key elements (from the visual report).
type AriaChange struct {
	Scenario string   `json:"scenario"`
	Role     string   `json:"role"`
	State    string   `json:"state"`
	Viewport int      `json:"viewport"`
	Diff     []string `json:"diff"`
}

// ReviewInput is what the reviewer prompt is written from.
type ReviewInput struct {
	Change, Task          string
	Attempt, MaxAttempts  int
	Root, ChangeDir, Code string
	DesignMap             string
	Scenarios             []*Scenario
	Pairs                 []Pair
	AriaChanges           []AriaChange
}

func vpsText(v *Vps) string {
	if v == nil {
		return ""
	}
	op := v.Op
	if op == "in" {
		op = ""
	}
	n := make([]string, len(v.Nums))
	for i, x := range v.Nums {
		n[i] = fmt.Sprint(x)
	}
	return fmt.Sprintf(" (@%s%s)", op, strings.Join(n, ","))
}

// ReviewPrompt is the prompt of the visual reviewer subagent: the scenarios, their before/after images, the ARIA changes,
// the rubric (and the design rubric for scenarios with a design reference) and the reply format.
func ReviewPrompt(p ReviewInput) string {
	var L []string
	add := func(f string, a ...any) { L = append(L, fmt.Sprintf(f, a...)) }
	add("Review the before/after images of task %s of the change `%s` (attempt %d of %d).", p.Task, p.Change, p.Attempt, p.MaxAttempts)
	add("The deterministic check already passed: no console errors, failed requests, axe violations, horizontal overflow, missing/hidden/offscreen/overlapping key elements or broken images, and no unintended change to other declared scenarios. Your job is what a script cannot see.")
	add("Images are clips of the affected area only (the box around the scenario's key elements), taken just before the task started and after the implementation. They are temporary run files, not baselines.")
	add("")
	var design []string
	for _, s := range p.Scenarios {
		add("## %s  (%s:%d)", s.ID, relTo(p.Root, s.File), s.ScenarioLine)
		add("Scenario: %s", s.Scenario)
		for _, w := range s.StepsText {
			add("  %s", w)
		}
		var refs []string
		for _, r := range s.References {
			if r.Error != "" {
				continue
			}
			if abs := ResolveReference(s, r.Path, p.ChangeDir, p.Root, p.Code); abs != "" {
				refs = append(refs, abs+vpsText(r.Vps))
			}
		}
		switch {
		case len(refs) > 1:
			add("Design references: %s", strings.Join(refs, ", "))
		case len(refs) == 1:
			add("Design reference: %s", refs[0])
		case s.Reference != "":
			if abs := ResolveReference(s, s.Reference, p.ChangeDir, p.Root, p.Code); abs != "" {
				add("Design reference: %s", abs)
			}
		}
		if len(refs) > 0 || (s.Reference != "" && ResolveReference(s, s.Reference, p.ChangeDir, p.Root, p.Code) != "") {
			design = append(design, s.ID)
		}
		if p.DesignMap != "" {
			add("Design map (what each region is built with): %s", p.DesignMap)
		}
		var states []string
		for _, x := range s.States {
			t := x.Name
			if len(x.Steps) > 0 {
				var steps []string
				for _, y := range x.Steps {
					v := y.Op
					if y.Target != "" {
						v += " " + y.Target
					}
					if y.Value != nil {
						v += " = " + *y.Value
					}
					steps = append(steps, v)
				}
				t += " (" + strings.Join(steps, "; ") + ")"
			}
			states = append(states, t)
		}
		add("States: %s", strings.Join(states, ", "))
		add("Key elements: %s", strings.Join(s.AllKeys(), ", "))
		add("Images (open every one; before -> after):")
		for _, pr := range p.Pairs {
			if pr.Scenario != s.ID {
				continue
			}
			b, a, side := pr.Before, pr.After, ""
			if b == "" {
				b = "(area not present before the task)"
			}
			if a == "" {
				a = "(area not present)"
			}
			if pr.SideBySide != "" {
				side = "; side by side with the design: " + pr.SideBySide
			}
			add("  - %s @ %dpx: before %s -> after %s%s", pr.State, pr.Viewport, b, a, side)
		}
		var ch []AriaChange
		for _, c := range p.AriaChanges {
			if c.Scenario == s.ID {
				ch = append(ch, c)
			}
		}
		if len(ch) > 0 {
			add("ARIA structure changes of the key elements (before -> after):")
			seen := map[string]bool{}
			for _, c := range ch {
				t := strings.Join(c.Diff, "\n")
				if seen[t] {
					continue
				}
				seen[t] = true
				var vps []string
				for _, x := range ch {
					if x.State == c.State && strings.Join(x.Diff, "\n") == t {
						vps = append(vps, fmt.Sprint(x.Viewport))
					}
				}
				add("  %s @ %spx:", c.State, strings.Join(vps, "/"))
				for _, d := range c.Diff {
					add("    %s", d)
				}
			}
		}
		add("")
	}
	var other []AriaChange
	for _, c := range p.AriaChanges {
		if c.Role != "task" {
			other = append(other, c)
		}
	}
	if len(other) > 0 {
		add("## In-scope changes to other declared scenarios (their component is in the task's Files:)")
		for _, c := range other {
			add("- %s [%s @ %dpx]: %s", c.Scenario, c.State, c.Viewport, strings.Join(c.Diff[:min(6, len(c.Diff))], " | "))
		}
		add("Flag them only if the scenario text says they should not change.")
		add("")
	}
	add("## Rubric")
	L = append(L, rubric...)
	if len(design) > 0 {
		add("")
		add("## Design rubric (%s)", strings.Join(design, ", "))
		L = append(L, designRubric...)
	}
	add("")
	add("## Reply format")
	if len(design) > 0 {
		add("First the RUBRIC lines (%s for %s), then one line per defect, then the status line last:", strings.Join(RubricItems, ", "), strings.Join(design, ", "))
		add("RUBRIC: %s spacing: pass - card gaps and padding match the design at 375 and 1280 (about 32px between cards on both sides)", design[0])
	} else {
		add("One line per defect, then the status line last:")
	}
	add("DEFECT: <scenario id> [<state> @ <width>px]: <what is wrong> -> <what is expected>")
	add("STATUS: pass        (no defects)   or   STATUS: fail   (at least one DEFECT line)   or   STATUS: error   (you could not open the images)")
	add("Do not edit any file.")
	return strings.Join(L, "\n") + "\n"
}

// RubricLine is one parsed `RUBRIC: <scenario> <item>: pass|fail - <citation>` line.
type RubricLine struct{ Scenario, Item, Verdict, Cite string }

var rubricRE = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?RUBRIC:\s*(\S+)\s+([a-z]+)\s*:\s*(pass|fail)\b\s*[-–—:]?\s*(.*)$`)

// ParseRubric reads the RUBRIC lines of a reviewer reply.
func ParseRubric(text string) []RubricLine {
	var out []RubricLine
	for l := range strings.SplitSeq(text, "\n") {
		if m := rubricRE.FindStringSubmatch(l); m != nil {
			item := strings.ToLower(m[2])
			if item == "color" {
				item = "colour"
			}
			out = append(out, RubricLine{m[1], item, strings.ToLower(m[3]), strings.TrimSpace(m[4])})
		}
	}
	return out
}

// RubricProblems lists what is wrong with a reviewer's rubric for the scenarios that need one (a missing item, an uncited item,
// a fail with STATUS pass or without a DEFECT line).
func RubricProblems(text string, ids []string, status string, defects []string) []string {
	if len(ids) == 0 {
		return nil
	}
	r := ParseRubric(text)
	var probs []string
	for _, id := range ids {
		for _, item := range RubricItems {
			i := slices.IndexFunc(r, func(x RubricLine) bool {
				return x.Item == item && (x.Scenario == id || strings.HasSuffix(id, "/"+x.Scenario))
			})
			switch {
			case i < 0:
				probs = append(probs, fmt.Sprintf("no RUBRIC line for %s %s", id, item))
			case len(strings.Fields(r[i].Cite)) < 3:
				probs = append(probs, fmt.Sprintf("RUBRIC %s %s has no citation (say what you compared on each side)", id, item))
			case r[i].Verdict == "fail" && status == "pass":
				probs = append(probs, fmt.Sprintf("RUBRIC %s %s fails but STATUS is pass", id, item))
			}
		}
	}
	if slices.ContainsFunc(r, func(x RubricLine) bool { return x.Verdict == "fail" }) && len(defects) == 0 {
		probs = append(probs, "a RUBRIC item fails but there is no DEFECT line")
	}
	return probs
}
