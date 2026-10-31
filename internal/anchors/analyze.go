package anchors

import (
	"regexp"
	"strings"
)

var (
	normTail     = regexp.MustCompile(`\s+(?://+|#+)(?:\s.*)?$`)
	spaces       = regexp.MustCompile(`\s+`)
	escapes      = regexp.MustCompile(`\\.`)
	stringLits   = regexp.MustCompile("'[^']*'|\"[^\"]*\"|`[^`]*`")
	lineComment  = regexp.MustCompile(`\s//.*$`)
	colonEnd     = regexp.MustCompile(`:\s*$`)
	semicolonEnd = regexp.MustCompile(`;\s*$`)
	endKeyword   = regexp.MustCompile(`^\s*end\b`)
)

func indentOf(l string) int {
	n := 0
	for _, c := range l {
		switch c {
		case ' ':
			n++
		case '\t':
			n += 4
		case '\r', '\v', '\f':
			n++
		default:
			return n
		}
	}
	return n
}

// NormLine drops a trailing line comment and collapses spacing (a unit's body ignores formatting).
func NormLine(l string) string {
	return strings.TrimSpace(spaces.ReplaceAllString(normTail.ReplaceAllString(l, ""), " "))
}

func stripStrings(l string) string {
	return lineComment.ReplaceAllString(stringLits.ReplaceAllString(escapes.ReplaceAllString(l, ""), `""`), "")
}

func blank(l string) bool { return strings.TrimSpace(l) == "" }

// Unit is the code one marker anchors.
type Unit struct {
	Key    string `json:"key"`
	Line   int    `json:"line"`  // 1-based marker line
	Start  int    `json:"start"` // 0-based, inclusive
	End    int    `json:"end"`
	Whole  bool   `json:"whole"`
	Header string `json:"header"`
	Body   string `json:"body"`
}

// Analyze returns the anchored unit of every marker of one text: the whole function (marker in its doc comment or
// directly above it) or the lines directly below the marker.
func Analyze(text string) []Unit {
	var out []Unit
	if !strings.Contains(text, "@spec") {
		return out
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	doc := docLines(lines)
	isComment := func(i int) bool { return commentLine.MatchString(lines[i]) || doc[i] }
	var starts []int
	isStart := map[int]bool{}
	for i, l := range lines {
		if !isComment(i) && IsUnitStart(l) {
			starts = append(starts, i)
			isStart[i] = true
		}
	}
	ends := map[int]int{}
	unitEnd := func(s int) int {
		if e, ok := ends[s]; ok {
			return e
		}
		brace := -1
		if !colonEnd.MatchString(lines[s]) {
			for j := s; j < min(len(lines), s+3); j++ {
				if isComment(j) {
					continue
				}
				if strings.Contains(lines[j], "{") {
					brace = j
					break
				}
				if semicolonEnd.MatchString(lines[j]) || (j > s && IsUnitStart(lines[j])) {
					break
				}
			}
		}
		end := s
		if brace >= 0 {
			depth, seen := 0, false
			end = len(lines) - 1
			for j := brace; j < len(lines); j++ {
				if isComment(j) {
					continue
				}
				for _, ch := range stripStrings(lines[j]) {
					switch ch {
					case '{':
						depth++
						seen = true
					case '}':
						depth--
					}
				}
				if seen && depth <= 0 {
					end = j
					break
				}
			}
		} else {
			ind := indentOf(lines[s])
			for j := s + 1; j < len(lines); j++ {
				if blank(lines[j]) {
					continue
				}
				if indentOf(lines[j]) > ind || (isComment(j) && indentOf(lines[j]) >= ind) {
					end = j
					continue
				}
				if indentOf(lines[j]) == ind && endKeyword.MatchString(lines[j]) {
					end = j
				}
				break
			}
		}
		ends[s] = end
		return end
	}
	bodyOf := func(a, b int) string {
		var o []string
		for j := a; j <= b && j < len(lines); j++ {
			if blank(lines[j]) || isComment(j) {
				continue
			}
			if n := NormLine(lines[j]); n != "" {
				o = append(o, n)
			}
		}
		return strings.Join(o, "\n")
	}
	for i, l := range lines {
		keys := KeysOf(l)
		if len(keys) == 0 {
			continue
		}
		at, _, _ := Leader(l)
		bareLead := strings.TrimSpace(starRuns.ReplaceAllString(l[:at], "")) == ""
		start, end, whole, header := -1, -1, false, ""
		enclosing := -1
		for _, s := range starts {
			if s <= i && unitEnd(s) >= i {
				enclosing = s
			}
		}
		if doc[i] && enclosing >= 0 && enclosing < i {
			start, end, whole = enclosing, unitEnd(enclosing), true
		} else {
			j := i + 1
			for j < len(lines) && (commentLine.MatchString(lines[j]) || annotation.MatchString(lines[j]) || doc[j]) {
				j++
			}
			if j < len(lines) && isStart[j] && !blank(lines[j]) && bareLead {
				start, end, whole = j, unitEnd(j), true
			}
		}
		if whole {
			header = NormLine(lines[start])
		} else {
			ind := indentOf(l)
			start, end = i+1, i
			if enclosing >= 0 {
				header = NormLine(lines[enclosing])
			}
			if !bareLead {
				start, end = i, i
			} else {
				for j := i + 1; j < len(lines); j++ {
					if blank(lines[j]) || closing.MatchString(lines[j]) || indentOf(lines[j]) < ind || len(KeysOf(lines[j])) > 0 {
						break
					}
					end = j
				}
			}
			if end < start {
				start, end = i, i
			}
		}
		for _, k := range keys {
			out = append(out, Unit{Key: k, Line: i + 1, Start: start, End: end, Whole: whole, Header: header, Body: bodyOf(start, end)})
		}
	}
	return out
}

// Event is a marker-level difference between two versions of a file.
type Event struct {
	Kind      string `json:"kind"` // modified | added | removed | moved
	Key       string `json:"key"`
	Line      int    `json:"line"`
	Header    string `json:"header"`
	Whole     bool   `json:"whole"`
	Body      string `json:"-"`
	Renamed   bool   `json:"renamed,omitempty"`
	File      string `json:"file"`
	From      string `json:"from,omitempty"`
	MovedFrom string `json:"moved_from,omitempty"`
	// MarkerOnly: a removed marker whose code is still in the file (only the marker went).
	MarkerOnly bool `json:"-"`
}

// Compare lists modified, added and removed anchors between two versions of one file.
func Compare(baseText, curText string) []Event {
	a, b := Analyze(baseText), Analyze(curText)
	id := func(u Unit) string {
		w := "P"
		if u.Whole {
			w = "U"
		}
		return u.Key + "|" + w + "|" + u.Header
	}
	type group struct {
		order []string
		m     map[string][]Unit
	}
	groupOf := func(xs []Unit) group {
		g := group{m: map[string][]Unit{}}
		for _, u := range xs {
			k := id(u)
			if _, ok := g.m[k]; !ok {
				g.order = append(g.order, k)
			}
			g.m[k] = append(g.m[k], u)
		}
		return g
	}
	ga, gb := groupOf(a), groupOf(b)
	var ev []Event
	var loseA, loseB []Unit
	for _, k := range gb.order {
		as := ga.m[k]
		for i, u := range gb.m[k] {
			if i < len(as) {
				if as[i].Body != u.Body {
					ev = append(ev, Event{Kind: "modified", Key: u.Key, Line: u.Line, Header: u.Header, Whole: u.Whole})
				}
			} else {
				loseB = append(loseB, u)
			}
		}
	}
	for _, k := range ga.order {
		bs := gb.m[k]
		for i, u := range ga.m[k] {
			if i >= len(bs) {
				loseA = append(loseA, u)
			}
		}
	}
	for _, u := range loseB {
		j := -1
		for x, w := range loseA {
			if w.Key == u.Key {
				j = x
				break
			}
		}
		if j >= 0 {
			loseA = append(loseA[:j], loseA[j+1:]...)
			ev = append(ev, Event{Kind: "modified", Key: u.Key, Line: u.Line, Header: u.Header, Whole: u.Whole, Renamed: true})
		} else {
			ev = append(ev, Event{Kind: "added", Key: u.Key, Line: u.Line, Header: u.Header, Whole: u.Whole, Body: u.Body})
		}
	}
	for _, u := range loseA {
		ev = append(ev, Event{Kind: "removed", Key: u.Key, Line: u.Line, Header: u.Header, Whole: u.Whole, Body: u.Body})
	}
	return ev
}
