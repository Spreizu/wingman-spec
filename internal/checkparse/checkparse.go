// Package checkparse turns the output of a lint, typecheck or test command into a short summary: counts and located
// failures. It reads TAP, JUnit XML, node --test (spec), vitest, jest, pytest and go test summaries and eslint and tsc file:line lines;
// every format whose lines appear is read (a command can run several tools). Output it cannot read gets no summary,
// and the caller shows the exit code and the tail instead.
package checkparse

import (
	"encoding/xml"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// MaxFailures is how many failures a summary lists.
const MaxFailures = 15

// Failure is one failing test or one lint or type error.
type Failure struct {
	File    string `json:"file,omitempty"`
	Line    int    `json:"line,omitempty"`
	Col     int    `json:"col,omitempty"`
	Name    string `json:"name,omitempty"`
	Message string `json:"message,omitempty"`
}

func (f Failure) String() string {
	var parts []string
	if f.File != "" {
		loc := f.File
		if f.Line > 0 {
			loc += ":" + strconv.Itoa(f.Line)
			if f.Col > 0 {
				loc += ":" + strconv.Itoa(f.Col)
			}
		}
		parts = append(parts, loc)
	}
	if f.Name != "" {
		parts = append(parts, f.Name)
	}
	if f.Message != "" {
		parts = append(parts, f.Message)
	}
	return strings.Join(parts, ": ")
}

// Summary is what a command's output says.
type Summary struct {
	Formats  []string  `json:"formats"`
	Passed   int       `json:"passed"`
	Failed   int       `json:"failed"`
	Skipped  int       `json:"skipped"`
	Errors   int       `json:"errors"` // lint and type errors
	Failures []Failure `json:"failures"`
	More     int       `json:"more,omitempty"` // failures not listed
}

// Read reports whether any format was recognised.
func (s *Summary) Read() bool { return len(s.Formats) > 0 }

// Counts is the one-line count ("3 failed, 40 passed, 1 skipped", "2 errors").
func (s *Summary) Counts() string {
	var parts []string
	for _, c := range []struct {
		n int
		w string
	}{{s.Failed, "failed"}, {s.Errors, "errors"}, {s.Passed, "passed"}, {s.Skipped, "skipped"}} {
		if c.n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", c.n, c.w))
		}
	}
	if len(parts) == 0 {
		return "no failures counted"
	}
	return strings.Join(parts, ", ")
}

// Lines is the summary as text: the counts with the formats, then one line per failure.
func (s *Summary) Lines() []string {
	out := []string{fmt.Sprintf("%s (%s)", s.Counts(), strings.Join(s.Formats, ", "))}
	for _, f := range s.Failures {
		out = append(out, "  "+f.String())
	}
	if s.More > 0 {
		out = append(out, fmt.Sprintf("  ... and %d more", s.More))
	}
	return out
}

func (s *Summary) add(format string, f ...Failure) {
	if !slices.Contains(s.Formats, format) {
		s.Formats = append(s.Formats, format)
	}
	for _, x := range f {
		x.Message = clip(x.Message)
		if slices.ContainsFunc(s.Failures, func(y Failure) bool { return y == x }) {
			continue
		}
		if len(s.Failures) >= MaxFailures {
			s.More++
			continue
		}
		s.Failures = append(s.Failures, x)
	}
}

func clip(m string) string {
	m = strings.TrimSpace(m)
	if i := strings.IndexByte(m, '\n'); i >= 0 {
		m = m[:i]
	}
	if r := []rune(m); len(r) > 200 {
		m = string(r[:197]) + "..."
	}
	return m
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// Parse reads a command's output, and a JUnit XML report when the project writes one (nil: none).
func Parse(output string, junit []byte) Summary {
	var s Summary
	out := strings.ReplaceAll(ansi.ReplaceAllString(output, ""), "\r\n", "\n")
	lines := strings.Split(out, "\n")
	if len(junit) > 0 {
		parseJUnit(&s, junit)
	}
	for _, p := range []func(*Summary, []string){parseTAP, parseNodeSpec, parseVitestJest, parsePytest, parseGo, parseESLint, parseTSC} {
		p(&s, lines)
	}
	return s
}

// ---------- JUnit XML ----------

type junitCase struct {
	Name      string `xml:"name,attr"`
	Classname string `xml:"classname,attr"`
	File      string `xml:"file,attr"`
	Line      int    `xml:"line,attr"`
	Failure   *struct {
		Message string `xml:"message,attr"`
		Body    string `xml:",chardata"`
	} `xml:"failure"`
	Error *struct {
		Message string `xml:"message,attr"`
		Body    string `xml:",chardata"`
	} `xml:"error"`
	Skipped *struct{} `xml:"skipped"`
}

type junitSuite struct {
	File   string       `xml:"file,attr"`
	Cases  []junitCase  `xml:"testcase"`
	Suites []junitSuite `xml:"testsuite"`
}

func parseJUnit(s *Summary, b []byte) {
	var root struct {
		XMLName xml.Name
		junitSuite
	}
	if xml.Unmarshal(b, &root) != nil || (root.XMLName.Local != "testsuites" && root.XMLName.Local != "testsuite") {
		return
	}
	s.add("junit")
	var walk func(js junitSuite, file string)
	walk = func(js junitSuite, file string) {
		if js.File != "" {
			file = js.File
		}
		for _, c := range js.Cases {
			name := c.Name
			if c.Classname != "" {
				name = c.Classname + " > " + c.Name
			}
			f := c.File
			if f == "" {
				f = file
			}
			switch {
			case c.Failure != nil || c.Error != nil:
				s.Failed++
				msg := ""
				if c.Failure != nil {
					msg = firstNonEmpty(c.Failure.Message, c.Failure.Body)
				} else {
					msg = firstNonEmpty(c.Error.Message, c.Error.Body)
				}
				line := c.Line
				switch {
				case line == 0 && f != "":
					line = lineIn(msg+"\n"+bodyOf(c), f)
				case f == "": // no file attribute (vitest, pytest): the first location in the trace
					if m := anyLoc.FindStringSubmatch(bodyOf(c)); m != nil {
						f = m[1]
						line, _ = strconv.Atoi(m[2])
					}
				}
				s.add("junit", Failure{File: f, Line: line, Name: name, Message: msg})
			case c.Skipped != nil:
				s.Skipped++
			default:
				s.Passed++
			}
		}
		for _, x := range js.Suites {
			walk(x, file)
		}
	}
	walk(root.junitSuite, "")
}

func bodyOf(c junitCase) string {
	if c.Failure != nil {
		return c.Failure.Body
	}
	if c.Error != nil {
		return c.Error.Body
	}
	return ""
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}

var anyLoc = regexp.MustCompile(`(?m)(?:^|[\s(])((?:[\w.@-]+/)*[\w.@-]+\.\w+):(\d+)`)

// lineIn finds "file:line" of file in a stack trace.
func lineIn(text, file string) int {
	re := regexp.MustCompile(regexp.QuoteMeta(file) + `:(\d+)`)
	if m := re.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

// ---------- TAP (node --test, tap, prove) ----------

var (
	tapPlan   = regexp.MustCompile(`^\s*1\.\.\d+`)
	tapResult = regexp.MustCompile(`^(\s*)(not ok|ok)\s+\d+\s*(?:-\s*)?(.*?)\s*$`)
	tapSkip   = regexp.MustCompile(`(?i)#\s*(skip|todo)\b`)
	tapAt     = regexp.MustCompile(`^\s*(?:at|location):\s*['"]?(?:file://)?([^'":\s]+):(\d+)`)
	tapMsg    = regexp.MustCompile(`^\s*(?:error|message):\s*['"|>-]*\s*(.*?)['"]?\s*$`)
	tapCount  = regexp.MustCompile(`^#\s*(pass|fail|skip|skipped|todo)\s+(\d+)\s*$`)
	tapParent = regexp.MustCompile(`subtestsFailed|^\s*error:\s*'\d+ subtests? failed'`)
)

func parseTAP(s *Summary, lines []string) {
	if !slices.ContainsFunc(lines, func(l string) bool { return tapPlan.MatchString(l) || strings.HasPrefix(l, "TAP version") }) {
		return
	}
	counted := map[string]int{}
	for _, l := range lines {
		if m := tapCount.FindStringSubmatch(l); m != nil {
			counted[m[1]], _ = strconv.Atoi(m[2])
		}
	}
	var fails []Failure
	pass, fail, skip := 0, 0, 0
	minIndent := -1
	for _, l := range lines {
		if m := tapResult.FindStringSubmatch(l); m != nil && (minIndent < 0 || len(m[1]) < minIndent) {
			minIndent = len(m[1])
		}
	}
	for i, l := range lines {
		m := tapResult.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		// node --test nests subtests: only the innermost failures are listed, the top level is counted
		top := len(m[1]) == minIndent
		switch {
		case tapSkip.MatchString(m[3]):
			if top {
				skip++
			}
		case m[2] == "ok":
			if top {
				pass++
			}
		default:
			if top {
				fail++
			}
			f := Failure{Name: m[3]}
			parent := false
			block := lines[i+1 : min(len(lines), i+40)]
			for k, d := range block {
				if tapResult.MatchString(d) {
					break
				}
				parent = parent || tapParent.MatchString(d)
				if a := tapAt.FindStringSubmatch(d); a != nil && f.File == "" {
					f.File = a[1]
					f.Line, _ = strconv.Atoi(a[2])
				}
				if mm := tapMsg.FindStringSubmatch(d); mm != nil && f.Message == "" {
					f.Message = mm[1]
					if f.Message == "" && k+1 < len(block) { // a YAML block scalar: the text is on the next line
						f.Message = strings.TrimSpace(block[k+1])
					}
				}
			}
			if !parent { // a parent that failed only through its subtests repeats them
				fails = append(fails, f)
			}
		}
	}
	if pass+fail+skip == 0 && len(counted) == 0 {
		return
	}
	if len(counted) > 0 {
		pass, fail, skip = counted["pass"], counted["fail"], counted["skip"]+counted["todo"]
	}
	s.Passed += pass
	s.Failed += fail
	s.Skipped += skip
	// a failing parent repeats its failing subtests: keep the innermost (the ones with a location first)
	slices.SortStableFunc(fails, func(a, b Failure) int {
		if (a.File == "") == (b.File == "") {
			return 0
		}
		if a.File != "" {
			return -1
		}
		return 1
	})
	s.add("tap", fails...)
}

// ---------- node --test, spec reporter (the default outside TAP since Node 20) ----------

var (
	nodeCount = regexp.MustCompile(`^ℹ (pass|fail|skipped|todo) (\d+)$`)
	nodeAt    = regexp.MustCompile(`^test at (.+?):(\d+):\d+$`)
	nodeName  = regexp.MustCompile(`^✖ (.*?)(?: \([\d.]+m?s\))?$`)
	nodeCode  = regexp.MustCompile(`^(\w*Error) \[[A-Z_]+\]: `)
)

func parseNodeSpec(s *Summary, lines []string) {
	counted := map[string]int{}
	for _, l := range lines {
		if m := nodeCount.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			counted[m[1]], _ = strconv.Atoi(m[2])
		}
	}
	if len(counted) == 0 || slices.ContainsFunc(lines, func(l string) bool { return strings.HasPrefix(l, "TAP version") }) {
		return
	}
	var fails []Failure
	for i, l := range lines {
		m := nodeAt.FindStringSubmatch(strings.TrimSpace(l))
		if m == nil || i+1 >= len(lines) {
			continue
		}
		f := Failure{File: m[1]}
		f.Line, _ = strconv.Atoi(m[2])
		if n := nodeName.FindStringSubmatch(strings.TrimSpace(lines[i+1])); n != nil {
			f.Name = n[1]
		}
		if i+2 < len(lines) {
			msg := strings.TrimSpace(lines[i+2])
			if strings.HasPrefix(msg, "AssertionError [") {
				msg = msg[strings.Index(msg, "]: ")+3:]
			}
			f.Message = nodeCode.ReplaceAllString(msg, "$1: ")
		}
		fails = append(fails, f)
	}
	s.Passed += counted["pass"]
	s.Failed += counted["fail"]
	s.Skipped += counted["skipped"] + counted["todo"]
	s.add("node", fails...)
}

// ---------- vitest and jest ----------

var (
	vjTotals   = regexp.MustCompile(`^\s*Tests:?\s+(.*\d.*)$`)
	vjCount    = regexp.MustCompile(`(\d+)\s+(failed|passed|skipped|todo|pending)`)
	vitestFail = regexp.MustCompile(`^\s*(?:FAIL|×|✗)\s+(\S+\.\w+)\s+>\s+(.*?)\s*$`)
	jestBullet = regexp.MustCompile(`^\s*●\s+(.*?)\s*$`)
	jsLoc      = regexp.MustCompile(`(?:❯|at\s.*?\(|at\s)\s*([^\s():]+\.[cm]?[jt]sx?):(\d+)(?::\d+)?`)
	vjMsg      = regexp.MustCompile(`^\s*((?:Assertion)?Error|TypeError|ReferenceError|expect\(.*|Expected.*|Received.*|AssertionError.*)(:.*)?$`)
)

func parseVitestJest(s *Summary, lines []string) {
	format := ""
	for _, l := range lines {
		if m := vjTotals.FindStringSubmatch(l); m != nil && vjCount.MatchString(m[1]) {
			format = "vitest"
			if strings.Contains(l, "Tests:") {
				format = "jest"
			}
			for _, c := range vjCount.FindAllStringSubmatch(m[1], -1) {
				n, _ := strconv.Atoi(c[1])
				switch c[2] {
				case "failed":
					s.Failed += n
				case "passed":
					s.Passed += n
				default:
					s.Skipped += n
				}
			}
		}
	}
	if format == "" {
		return
	}
	var fails []Failure
	for i, l := range lines {
		var f Failure
		switch {
		case vitestFail.MatchString(l):
			m := vitestFail.FindStringSubmatch(l)
			f = Failure{File: m[1], Name: m[2]}
		case jestBullet.MatchString(l) && !strings.Contains(l, "Console"):
			f = Failure{Name: jestBullet.FindStringSubmatch(l)[1]}
		default:
			continue
		}
		for _, d := range lines[i+1 : min(len(lines), i+30)] {
			if vitestFail.MatchString(d) || jestBullet.MatchString(d) {
				break
			}
			if m := vjMsg.FindStringSubmatch(d); m != nil && f.Message == "" {
				f.Message = strings.TrimSpace(d)
			}
			if m := jsLoc.FindStringSubmatch(d); m != nil && f.Line == 0 && !strings.Contains(d, "node_modules") {
				f.File = m[1]
				f.Line, _ = strconv.Atoi(m[2])
			}
		}
		fails = append(fails, f)
	}
	s.add(format, fails...)
}

// ---------- pytest ----------

var (
	pyTotals = regexp.MustCompile(`^=+ (.*\d+ (?:passed|failed|error|errors|skipped).*?) in [\d.]+s.*=+$`)
	pyCount  = regexp.MustCompile(`(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)`)
	pyFailed = regexp.MustCompile(`^(?:FAILED|ERROR) (\S+?)::(\S+)(?: - (.*))?$`)
	pyLoc    = regexp.MustCompile(`^(\S+\.py):(\d+): `)
)

func parsePytest(s *Summary, lines []string) {
	found := false
	for _, l := range lines {
		if m := pyTotals.FindStringSubmatch(l); m != nil {
			found = true
			for _, c := range pyCount.FindAllStringSubmatch(m[1], -1) {
				n, _ := strconv.Atoi(c[1])
				switch c[2] {
				case "passed", "xpassed":
					s.Passed += n
				case "failed", "error", "errors":
					s.Failed += n
				default:
					s.Skipped += n
				}
			}
		}
	}
	if !found {
		return
	}
	locs := map[string]int{}
	for _, l := range lines {
		if m := pyLoc.FindStringSubmatch(l); m != nil {
			locs[m[1]], _ = strconv.Atoi(m[2])
		}
	}
	var fails []Failure
	for _, l := range lines {
		if m := pyFailed.FindStringSubmatch(l); m != nil {
			fails = append(fails, Failure{File: m[1], Line: locs[m[1]], Name: m[2], Message: m[3]})
		}
	}
	s.add("pytest", fails...)
}

// ---------- go test ----------

var (
	goFail    = regexp.MustCompile(`^\s*--- FAIL: (\S+)`)
	goPass    = regexp.MustCompile(`^\s*--- PASS: `)
	goSkip    = regexp.MustCompile(`^\s*--- SKIP: `)
	goPkg     = regexp.MustCompile(`^(ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[build failed\]|\[setup failed\])`)
	goLoc     = regexp.MustCompile(`^\s+(\S+_test\.go|\S+\.go):(\d+): (.*)$`)
	goStep    = regexp.MustCompile(`^\s*(=== |--- |FAIL\b|ok\s|PASS$)`)
	goBuildEr = regexp.MustCompile(`^(\S+\.go):(\d+):\d+: (.*)$`)
)

func parseGo(s *Summary, lines []string) {
	if !slices.ContainsFunc(lines, func(l string) bool { return goPkg.MatchString(l) || goFail.MatchString(l) }) {
		return
	}
	var fails []Failure
	for i, l := range lines {
		switch {
		case goPass.MatchString(l):
			s.Passed++
		case goSkip.MatchString(l):
			s.Skipped++
		case goFail.MatchString(l):
			s.Failed++
			f := Failure{Name: goFail.FindStringSubmatch(l)[1]}
			loc := func(d string) {
				if m := goLoc.FindStringSubmatch(d); m != nil && f.File == "" {
					f.File, f.Message = m[1], m[3]
					f.Line, _ = strconv.Atoi(m[2])
				}
			}
			// go test -v prints a test's messages before its --- FAIL line, plain go test right after it
			for k := i - 1; k >= 0 && !goStep.MatchString(lines[k]); k-- {
				loc(lines[k])
			}
			for k := i + 1; f.File == "" && k < len(lines) && !goStep.MatchString(lines[k]); k++ {
				loc(lines[k])
			}
			fails = append(fails, f)
		case goBuildEr.MatchString(l):
			m := goBuildEr.FindStringSubmatch(l)
			n, _ := strconv.Atoi(m[2])
			s.Errors++
			fails = append(fails, Failure{File: m[1], Line: n, Message: m[3]})
		}
	}
	s.add("go test", fails...)
}

// ---------- eslint ----------

var (
	eslintFile  = regexp.MustCompile(`^(/\S+|\S+\.[cm]?[jt]sx?|\S+\.vue|\S+\.svelte)$`)
	eslintLine  = regexp.MustCompile(`^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?\s*$`)
	eslintTotal = regexp.MustCompile(`✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)`)
	eslintUnix  = regexp.MustCompile(`^(\S+?):(\d+):(\d+): (.*?) \[(Error|Warning)/(\S+)\]$`)
)

func parseESLint(s *Summary, lines []string) {
	file := ""
	var fails []Failure
	errs, seen := 0, false
	for _, l := range lines {
		switch {
		case eslintTotal.MatchString(l):
			seen = true
		case eslintFile.MatchString(l):
			file = l
		case eslintLine.MatchString(l) && file != "":
			m := eslintLine.FindStringSubmatch(l)
			if m[3] == "error" {
				n, _ := strconv.Atoi(m[1])
				c, _ := strconv.Atoi(m[2])
				msg := m[4]
				if m[5] != "" {
					msg += " (" + m[5] + ")"
				}
				fails = append(fails, Failure{File: file, Line: n, Col: c, Message: msg})
				errs++
			}
			seen = true
		case eslintUnix.MatchString(l):
			m := eslintUnix.FindStringSubmatch(l)
			if m[5] == "Error" {
				n, _ := strconv.Atoi(m[2])
				c, _ := strconv.Atoi(m[3])
				fails = append(fails, Failure{File: m[1], Line: n, Col: c, Message: m[4] + " (" + m[6] + ")"})
				errs++
			}
			seen = true
		}
	}
	if !seen {
		return
	}
	s.Errors += errs
	s.add("eslint", fails...)
}

// ---------- tsc ----------

var (
	tscParen = regexp.MustCompile(`^(\S+?)\((\d+),(\d+)\): error (TS\d+: .*)$`)
	tscColon = regexp.MustCompile(`^(\S+?):(\d+):(\d+) - error (TS\d+: .*)$`)
)

func parseTSC(s *Summary, lines []string) {
	var fails []Failure
	for _, l := range lines {
		m := tscParen.FindStringSubmatch(l)
		if m == nil {
			m = tscColon.FindStringSubmatch(l)
		}
		if m != nil {
			n, _ := strconv.Atoi(m[2])
			c, _ := strconv.Atoi(m[3])
			fails = append(fails, Failure{File: m[1], Line: n, Col: c, Message: m[4]})
		}
	}
	if len(fails) == 0 {
		return
	}
	s.Errors += len(fails)
	s.add("tsc", fails...)
}
