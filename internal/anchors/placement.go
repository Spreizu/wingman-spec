// Package anchors reads `@spec <capability>/<requirement-slug>` markers in code: where they sit (placement), the unit each
// one anchors (Analyze), how anchored code changed against a base (Guard), whether there are too many or misplaced ones
// (Fit), what the test output says about tagged scenarios (Evidence) and which anchored code changed after its
// requirement text (Stale). Language-agnostic line heuristics, no parsers, nothing stored.
//
// The placement rules:
//   - a requirement implemented by a whole function, method or class: the marker goes in that unit's doc comment, once;
//   - a requirement implemented by part of a unit: the marker goes on its own line directly above those lines, once;
//   - never at the end of a code line, never at the top of a file with several functions, never detached from code;
//   - one marker per requirement per unit.
package anchors

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	leaderComment = regexp.MustCompile(`(?://+|#+|/\*+|\*+|-{2,}|;+|<!--|%+|\{#|"""|''')\s*@spec\b`)
	leaderBare    = regexp.MustCompile(`^\s*@spec\b`)
	bareKeyAhead  = regexp.MustCompile(`^\s+[a-z0-9][a-z0-9-]*/[a-z0-9]`)
	// KeyRE is one key after a marker leader (or after another key, separated by a comma or semicolon).
	KeyRE = regexp.MustCompile(`^\s*[,;]?\s*([a-z0-9][a-z0-9-]*)/([a-z0-9][a-z0-9-]*)`)

	commentLine = regexp.MustCompile(`^\s*(?://|#(?:[^\[]|$)|/\*|\*|--|;|<!--|%|\{#|"""|''')`)
	annotation  = regexp.MustCompile(`^\s*(?:@[\w.]+(?:\(.*\))?\s*$|#\[.*\]\s*$|\[[A-Z]\w*.*\]\s*$)`)
	control     = regexp.MustCompile(`^\s*(?:if|else|for|foreach|while|switch|catch|try|do|return|elif|except|with|match|case|using|lock|synchronized)\b`)
	closing     = regexp.MustCompile(`^\s*(?:[}\])]+[;,]?|end|</\w+>)\s*$`)
	mods        = `(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|sealed|pub|unsafe|extern|readonly|open|suspend|inline)\s+)*`
	unitKW      = regexp.MustCompile(`^\s*` + mods + `(?:function\b|def\b|class\b|interface\b|struct\b|impl\b|trait\b|enum\b|func\b|fn\b|fun\b|sub\b|object\b|module\b|record\b|type\s+\w+\s+(?:struct|interface)\b)`)
	unitArrow   = regexp.MustCompile(`^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+?)?=>`)
	unitTest    = regexp.MustCompile(`^\s*(?:it|test|describe|context|suite|specify)(?:\.\w+)*\s*\(`)
	unitMethod  = regexp.MustCompile(`^\s*(?:(?:public|private|protected|static|final|async|override|virtual|abstract|synchronized|readonly|get|set)\s+)*(?:[\w<>\[\],.?*&:]+\s+)?[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?::\s*[\w<>\[\]|,.? ]+)?\s*(?:throws\s+[\w., ]+)?\s*\{\s*$`)
	unitTag     = regexp.MustCompile(`^\s*<(?:script|template|style)\b`)
	leadOnly    = regexp.MustCompile(`^\s*(?:/\*+|\*+)?\s*$`)
	starRuns    = regexp.MustCompile(`/\*+|\*+`)
	tripleQuote = regexp.MustCompile(`"""|'''`)
)

// Leader finds the comment leader plus `@spec` of a marker line: start index and end index, ok=false when the line has none.
func Leader(l string) (int, int, bool) {
	a := leaderComment.FindStringIndex(l)
	if b := leaderBare.FindStringIndex(l); b != nil && bareKeyAhead.MatchString(l[b[1]:]) {
		if a == nil || b[0] < a[0] {
			return b[0], b[1], true
		}
	}
	if a == nil {
		return 0, 0, false
	}
	return a[0], a[1], true
}

// KeysOf returns the keys of the markers on one line.
func KeysOf(l string) []string {
	_, end, ok := Leader(l)
	if !ok {
		return nil
	}
	var keys []string
	rest := l[end:]
	for {
		m := KeyRE.FindStringSubmatchIndex(rest)
		if m == nil {
			break
		}
		keys = append(keys, rest[m[2]:m[3]]+"/"+rest[m[4]:m[5]])
		rest = rest[m[1]:]
	}
	return keys
}

// Marker is one key of one marker line.
type Marker struct {
	Key  string `json:"key"`
	File string `json:"file,omitempty"`
	Line int    `json:"line"`
	Test bool   `json:"test,omitempty"`
}

// MarkersIn lists the markers of one text.
func MarkersIn(text string) []Marker {
	var out []Marker
	for i, l := range strings.Split(text, "\n") {
		for _, k := range KeysOf(l) {
			out = append(out, Marker{Key: k, Line: i + 1})
		}
	}
	return out
}

// IsUnitStart reports whether a line looks like the start of a function, method, class, test or component block.
func IsUnitStart(l string) bool {
	return !control.MatchString(l) && (unitKW.MatchString(l) || unitArrow.MatchString(l) || unitTest.MatchString(l) || unitMethod.MatchString(l) || unitTag.MatchString(l))
}

// docLines marks the lines inside Python-style triple-quoted docstrings.
func docLines(lines []string) []bool {
	doc := make([]bool, len(lines))
	in := false
	for i, l := range lines {
		odd := len(tripleQuote.FindAllString(l, -1))%2 == 1
		doc[i] = in || odd
		if odd {
			in = !in
		}
	}
	return doc
}

// Placement fix texts.
var placementFix = map[string]string{
	"trailing-marker":  "the marker is at the end of a code line: put it on its own line directly above the code it covers (or in the doc comment of the whole function)",
	"duplicate-marker": "the same requirement is marked more than once in this function/unit: one marker per requirement per unit (doc comment for the whole unit, or one comment before the lines for a part)",
	"file-top-marker":  "the marker sits at the top of a file with several functions, so it does not say which one implements the requirement: move it into the doc comment of that function, or above the lines that implement it",
	"detached-marker":  "the marker is not directly above code (a blank line or the end of a block follows): put it on the line(s) it covers, or in the doc comment of the whole function",
}

// PlacementFinding is one misplaced marker.
type PlacementFinding struct {
	File string   `json:"file,omitempty"`
	Line int      `json:"line"`
	Kind string   `json:"kind"`
	Keys []string `json:"keys"`
	Text string   `json:"text"`
}

// Placement returns the placement findings of one file. Test files may carry one marker at the top for the whole file.
func Placement(text string, isTest bool) []PlacementFinding {
	var out []PlacementFinding
	if !strings.Contains(text, "@spec") {
		return out
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	doc := docLines(lines)
	var starts []int
	isStart := map[int]bool{}
	for i, l := range lines {
		if !commentLine.MatchString(l) && !doc[i] && IsUnitStart(l) {
			starts = append(starts, i)
			isStart[i] = true
		}
	}
	before := func(i int) int {
		n := 0
		for _, s := range starts {
			if s < i {
				n++
			}
		}
		return n
	}
	seen := map[string]bool{}
	for i, l := range lines {
		at, _, ok := Leader(l)
		if !ok {
			continue
		}
		keys := KeysOf(l)
		if len(keys) == 0 {
			continue
		}
		push := func(kind string) {
			out = append(out, PlacementFinding{Line: i + 1, Kind: kind, Keys: keys, Text: placementFix[kind]})
		}
		lead := l[:at]
		if strings.TrimSpace(lead) != "" && !leadOnly.MatchString(lead) {
			push("trailing-marker")
		}
		seg := before(i)
		if !doc[i] && strings.TrimSpace(starRuns.ReplaceAllString(lead, "")) == "" {
			j := i + 1
			for j < len(lines) && (commentLine.MatchString(lines[j]) || annotation.MatchString(lines[j]) || doc[j]) {
				j++
			}
			attached := j < len(lines) && strings.TrimSpace(lines[j]) != "" && !closing.MatchString(lines[j])
			switch {
			case attached && isStart[j]:
				seg = before(i) + 1
			case !isTest && before(i) == 0 && len(starts) >= 2:
				push("file-top-marker")
			case !attached:
				push("detached-marker")
			}
		}
		for _, k := range keys {
			id := strconv.Itoa(seg) + "|" + k
			if seen[id] {
				out = append(out, PlacementFinding{Line: i + 1, Kind: "duplicate-marker", Keys: []string{k}, Text: placementFix["duplicate-marker"]})
			} else {
				seen[id] = true
			}
		}
	}
	return out
}
