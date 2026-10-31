package anchors

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Fit defaults: anchors per requirement above which weak ones are named, the count above which a fitting set still gets
// an info line, and the number of requirements one small unit may carry.
const (
	DefaultMax = 6
	ceiling    = 12
	crowd      = 3
)

var (
	fitStop   = map[string]bool{}
	camelRE   = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	nonAlnum  = regexp.MustCompile(`[^a-z0-9]+`)
	stemEnd   = regexp.MustCompile(`(?:ing|ed|es|s)$`)
	allDigits = regexp.MustCompile(`^\d+$`)

	trDir    = `(?:lang|langs|language|languages|locale|locales|l10n|i18n|translations?)`
	trData   = `(?:json|ya?ml|php|xml|po|pot|xlf|xliff|arb|strings|stringsdict|properties|resx|ini|toml|csv|txt|mo|ts|js)`
	trCode   = regexp.MustCompile(`(?i)\.(?:tsx?|jsx?|mjs|cjs|vue|py|rb|go|java|kt|kts|cs|swift|rs|dart|scala|c|cc|cpp|h|m)$`)
	trStrong = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\.(?:po|pot|xlf|xliff|arb|strings|stringsdict|xcstrings|resx)$`),
		regexp.MustCompile(`(?i)(?:^|/)[^/]+\.lproj/`),
		regexp.MustCompile(`(?i)(?:^|/)values(?:-[\w+]+)*/(?:strings|plurals|arrays)\.xml$`),
		regexp.MustCompile(`(?i)(?:^|/)locale/[^/]+/lc_messages/`),
		regexp.MustCompile(`(?i)(?:^|/)(?:messages|validators|security|translations?|strings|labels?|bundle|text)(?:[._-][a-z]{2,3}(?:[_-][a-z]{2,4})?)?\.properties$`),
		regexp.MustCompile(`(?i)(?:^|/)(?:messages|validators|security|translations?|strings|labels?)[._-][a-z]{2,3}(?:[_-][a-z]{2,4})?\.(?:php|json|ya?ml|xml|ini)$`),
		regexp.MustCompile(`(?i)(?:^|/)` + trDir + `/(?:.+/)?[^/]+\.(?:json|ya?ml|php|xml|ini|toml|csv|txt|mo)$`),
		regexp.MustCompile(`(?i)(?:^|/)(?:messages|strings|translations?)\.(?:php|js|ts|json|ya?ml)$`),
	}
	trWeak      = []*regexp.Regexp{regexp.MustCompile(`(?i)(?:^|/)` + trDir + `/.+\.` + trData + `$`), regexp.MustCompile(`(?i)(?:^|/)(?:messages?|strings|intl)/`)}
	trDirSeg    = regexp.MustCompile(`(?i)(?:^|/)` + trDir + `/`)
	configPath  = regexp.MustCompile(`(?i)(^|/)(config|settings|configs?)(/|\.[a-z]+$)|(^|/)\.env|\.(json|ya?ml|toml|ini|env|cfg|conf)$|(^|/)(package|tsconfig|webpack\.config|vite\.config|composer|pom|build)\.[a-z]+$`)
	entry       = regexp.MustCompile("^\\s*['\"]?[\\w.\\-:/ ]+['\"]?\\s*(?:=>|:|=)\\s*(?:['\"`].*['\"`]|\\[.*\\]|\\{.*\\}|\\d+|true|false|null)\\s*,?\\s*$")
	importRE    = regexp.MustCompile(`^\s*(?:import\b|from\s+\S+\s+import\b|use\s+[\w\\]+|using\s+[\w.]+;|require(?:_once)?\b|#include\b|package\s+[\w.]+;?\s*$|(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\()`)
	sqlText     = regexp.MustCompile("['\"`]\\s*(?:SELECT\\s|INSERT\\s+INTO\\b|UPDATE\\s+\\S+\\s+SET\\b|DELETE\\s+FROM\\b)")
	constant    = regexp.MustCompile(`^\s*(?:(?:export|public|private|protected|static|final|readonly|pub)\s+)*(?:const|val|let|var|define)\s*\(?\s*['"]?[A-Z][A-Z0-9_]{2,}['"]?\s*[:=,)]|^\s*(?:(?:public|private|protected|static|final|readonly)\s+)+(?:const\s+)?[\w<>\[\]]*\s*[A-Z][A-Z0-9_]{2,}\s*=|^[A-Z][A-Z0-9_]{2,}\s*=`)
	typeDecl    = regexp.MustCompile(`^\s*(?:export\s+)?(?:declare\s+)?(?:type\s+\w+(?:<[^>]*>)?\s*=|interface\s+\w+|enum\s+\w+|struct\s+\w+|typedef\b)`)
	accHead     = regexp.MustCompile(`^\s*(?:(?:public|private|protected|static|final|override|async)\s+)*(?:(?:get|set)\s+\w+\s*\(|(?:function\s+)?(?:[\w<>\[\],.?]+\s+)?(?:get|set|is|has)[A-Z]\w*\s*\(|def\s+(?:get|set|is|has)_\w+\s*\()`)
	accBody     = regexp.MustCompile(`^\s*(?:return\s+)?(?:\$?this->|this\.|self\.|@)?\$?\w+(?:\s*=\s*\$?\w+)?\s*;?\s*$|return\s+(?:\$?this->|this\.|self\.)\$?\w+\s*;?`)
	logging     = regexp.MustCompile(`^\s*(?:console\.(?:log|warn|error|info|debug)|(?:this\.|self\.)?(?:logger|log)\.(?:info|debug|warn|warning|error|trace)|logging\.\w+|log\.(?:Print|Fatal|Panic)\w*\s*\(|print(?:ln|f)?\s*\(|System\.out\.print|fmt\.Print|Log::\w+|error_log\s*\(|Rails\.logger|puts\s)`)
	phpUnit     = regexp.MustCompile(`^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait)\b|^\s*(?:(?:public|private|protected|static)\s+)*function\b`)
	closer      = regexp.MustCompile(`^\s*[}\])]`)
	bareName    = regexp.MustCompile(`^\s*\w+,?\s*$`)
	fromQuote   = regexp.MustCompile(`from\s+['"]`)
	behaviourKW = regexp.MustCompile(`\b(?:function|def|=>|if|for|while|return)\b`)
	braceOnly   = regexp.MustCompile(`^\s*[{}]\s*$`)
	extEnd      = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)
	nonAlnumAny = regexp.MustCompile(`[^a-zA-Z0-9]+`)
	edgeDash    = regexp.MustCompile(`^-|-$`)
	anchorsMany = regexp.MustCompile(`(?mi)^\s*Anchors:\s*many\b`)
)

func init() {
	for w := range strings.FieldsSeq("the a an and or of to in on at by for with from is are be been being as it its this that these those shall must should may can will would when then given but not no any all each every if else than into onto over under after before while who whom what which where how why " +
		"user users system page view show shows shown display displays displayed see sees visible value values item items one two new existing current") {
		fitStop[w] = true
	}
}

func fitWords(text string) map[string]bool {
	out := map[string]bool{}
	spaced := strings.ToLower(camelRE.ReplaceAllString(text, "$1 $2"))
	for _, w := range nonAlnum.Split(spaced, -1) {
		if len(w) < 3 || fitStop[w] || allDigits.MatchString(w) {
			continue
		}
		out[stemEnd.ReplaceAllString(w, "")] = true
	}
	return out
}

func sameStem(a, b string) bool {
	return a == b || (min(len(a), len(b)) >= 4 && (strings.HasPrefix(a, b) || strings.HasPrefix(b, a))) || (len(a) >= 5 && len(b) >= 5 && a[:5] == b[:5])
}

func overlapOf(req, unit map[string]bool) int {
	n := 0
	for r := range req {
		for u := range unit {
			if sameStem(r, u) {
				n++
				break
			}
		}
	}
	return n
}

// i18nPath is "strong" when the path alone says the file is a string table, "weak" when only its directory says so.
func i18nPath(file string) string {
	f := strings.ReplaceAll(file, `\`, "/")
	for _, re := range trStrong {
		if re.MatchString(f) {
			return "strong"
		}
	}
	for _, re := range trWeak {
		if re.MatchString(f) {
			return "weak"
		}
	}
	if trCode.MatchString(f) && trDirSeg.MatchString(f) {
		return "weak"
	}
	return ""
}

func all(xs []string, f func(string) bool) bool {
	for _, x := range xs {
		if !f(x) {
			return false
		}
	}
	return true
}

// boilerplateKind names the non-behaviour a unit is (i18n, import, type, constant, accessor, logging, config), or "".
func boilerplateKind(file string, code []string) string {
	tr := i18nPath(file)
	if tr == "strong" && strings.HasSuffix(strings.ToLower(file), ".php") && slices.ContainsFunc(code, phpUnit.MatchString) {
		tr = "weak"
	}
	if tr == "strong" {
		return "i18n"
	}
	if len(code) == 0 {
		return ""
	}
	head := code[0]
	joined := strings.Join(code, " ")
	if importRE.MatchString(head) && all(code, func(l string) bool {
		return importRE.MatchString(l) || closer.MatchString(l) || bareName.MatchString(l) || fromQuote.MatchString(l)
	}) {
		return "import"
	}
	if typeDecl.MatchString(head) {
		return "type"
	}
	if constant.MatchString(head) && len(code) <= 6 && !sqlText.MatchString(joined) {
		return "constant"
	}
	if accHead.MatchString(head) && len(code) <= 5 && all(code[1:], func(l string) bool { return accBody.MatchString(l) || braceOnly.MatchString(l) }) {
		return "accessor"
	}
	if logging.MatchString(head) && len(code) <= 3 {
		return "logging"
	}
	entries := 0
	for _, l := range code {
		if entry.MatchString(l) {
			entries++
		}
	}
	if entries >= 1 && float64(entries)/float64(len(code)) >= 0.6 && !behaviourKW.MatchString(joined) {
		if tr == "weak" || !configPath.MatchString(file) {
			return "i18n"
		}
		return "config"
	}
	if configPath.MatchString(file) {
		return "config"
	}
	return ""
}

var fitReason = map[string]string{
	"i18n":     "a string-table entry (translations, locale or message files)",
	"import":   "an import",
	"type":     "a type declaration",
	"constant": "a constant",
	"accessor": "a getter or setter",
	"logging":  "a log call",
	"config":   "configuration",
}

func slugSeg(s string) string {
	s = camelRE.ReplaceAllString(s, "$1-$2")
	s = extEnd.ReplaceAllString(s, "")
	s = strings.ToLower(nonAlnumAny.ReplaceAllString(s, "-"))
	return edgeDash.ReplaceAllString(s, "")
}

func capsOfPath(file string, capNames map[string]bool) map[string]bool {
	out := map[string]bool{}
	segs := map[string]bool{}
	for s := range strings.SplitSeq(file, "/") {
		segs[slugSeg(s)] = true
	}
	for c := range capNames {
		if segs[c] {
			out[c] = true
		}
	}
	return out
}

func fixOverAnchored(n, max int, weak []string) string {
	return strconv.Itoa(n) + " code anchors for one requirement (more than " + strconv.Itoa(max) + "); weak: " + strings.Join(weak, ", ") + " (a second marker in one unit, or a finding of its own). Remove or move those; the anchors that pass the fit stay (or mark a requirement that is truly spread over many files with `Anchors: many`)"
}

const (
	fixAgain     = "a second marker of the requirement in a unit that already carries it (a function carries a requirement once): remove it"
	fixUnrelated = "no word of the requirement (name, text, scenarios) appears in this unit, its header or its file name: remove the marker, or move it to the code that implements the requirement"
)

func fixMany(n int) string {
	return strconv.Itoa(n) + " code anchors, each of them fits: no change needed. Is this one requirement, or several that should be split? (`Anchors: many` in the requirement, or anchor_many in the config, silences this line)"
}
func fixBoilerplate(why string) string {
	return "the marker sits on " + why + ", which decides no behaviour: remove it; a requirement is anchored where its behaviour is decided, not on imports, types, constants, string tables, getters or logging"
}
func fixCrowded(n int) string {
	return strconv.Itoa(n) + " different requirements are anchored in this one unit: anchor each where its own behaviour is decided, and remove the markers that only describe code the unit happens to contain"
}
func fixForeign(cap, file string) string {
	return "the file belongs to `" + cap + "`, another capability: a requirement is not anchored on code of a different feature because it is related or visible afterwards. Remove the marker, or move it to the code that decides this requirement (" + file + ")"
}

// FitFile is a file that carries markers.
type FitFile struct {
	File, Text string
	Test       bool
}

// FitReq is a known requirement.
type FitReq struct{ Name, Block, Cap string }

// FitOpts are the inputs of FitFindings.
type FitOpts struct {
	Files    []FitFile
	Reqs     map[string]FitReq
	CapNames map[string]bool
	TaskCaps map[string]map[string]bool // file -> capabilities of the tasks whose Files: line names it
	Max      int
	Many     map[string]bool
}

// FitFinding is one anchor-fit finding; Remove: deleting this marker is the suggested fix.
type FitFinding struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Key    string `json:"key"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Remove bool   `json:"remove"`
	Info   bool   `json:"info,omitempty"`
}

type fitAnchor struct {
	Unit
	file      string
	code      []string
	unitLines int
	kind      string
	words     map[string]bool
	overlap   int
}

// FitFindings judges whether anchors belong where they sit: boilerplate, foreign, unrelated, crowded units, and too many
// anchors for one requirement when some are weak. Test files are read but never judged.
func FitFindings(o FitOpts) []FitFinding {
	max := o.Max
	if max <= 0 {
		max = DefaultMax
	}
	var anchors []*fitAnchor
	for _, f := range o.Files {
		if f.Test || !strings.Contains(f.Text, "@spec") {
			continue
		}
		lines := strings.Split(strings.ReplaceAll(f.Text, "\r\n", "\n"), "\n")
		var here []*fitAnchor
		for _, u := range Analyze(f.Text) {
			var code []string
			for j := u.Start; j <= min(u.End, u.Start+80) && j < len(lines); j++ {
				if !blank(lines[j]) && !commentLine.MatchString(lines[j]) {
					code = append(code, lines[j])
				}
			}
			here = append(here, &fitAnchor{Unit: u, file: f.File, code: code, unitLines: u.End - u.Start + 1})
		}
		// stacked markers share the code, header and size of the next marker's unit when within 3 lines
		for i := range here {
			if len(here[i].code) > 0 {
				continue
			}
			for k := i + 1; k < len(here); k++ {
				if here[k].Line-here[k-1].Line > 3 {
					break
				}
				if len(here[k].code) == 0 {
					continue
				}
				here[i].code = here[k].code
				if here[i].Header == "" {
					here[i].Header = here[k].Header
				}
				here[i].unitLines = max2(here[i].unitLines, here[k].unitLines)
				break
			}
		}
		for _, a := range here {
			a.kind = boilerplateKind(a.file, a.code)
			a.words = fitWords(a.Header + " " + strings.Join(a.code, " ") + " " + a.file)
			anchors = append(anchors, a)
		}
	}
	var out []*FitFinding
	flagged := map[string]bool{}
	id := func(a *fitAnchor) string { return a.file + ":" + strconv.Itoa(a.Line) + ":" + a.Key }
	add := func(a *fitAnchor, kind, text string) {
		if flagged[id(a)+":"+kind] {
			return
		}
		flagged[id(a)+":"+kind] = true
		out = append(out, &FitFinding{File: a.file, Line: a.Line, Key: a.Key, Kind: kind, Text: a.file + ":" + strconv.Itoa(a.Line) + ": `" + a.Key + "`: " + text, Remove: true})
	}
	byKey := map[string][]*fitAnchor{}
	var keyOrder []string
	for _, a := range anchors {
		if _, ok := o.Reqs[a.Key]; !ok {
			continue
		}
		if _, ok := byKey[a.Key]; !ok {
			keyOrder = append(keyOrder, a.Key)
		}
		byKey[a.Key] = append(byKey[a.Key], a)
	}
	bad := map[string]bool{}
	for _, key := range keyOrder {
		list := byKey[key]
		r := o.Reqs[key]
		cap := r.Cap
		if cap == "" {
			cap, _, _ = strings.Cut(key, "/")
		}
		rw := fitWords(r.Name + " " + r.Block + " " + cap)
		keyCap, _, _ := strings.Cut(key, "/")
		for _, a := range list {
			a.overlap = overlapOf(rw, a.words)
			if a.kind != "" {
				add(a, "boilerplate-anchor", fixBoilerplate(fitReason[a.kind]))
				bad[id(a)] = true
				continue
			}
			owners := capsOfPath(a.file, o.CapNames)
			for c := range o.TaskCaps[a.file] {
				owners[c] = true
			}
			if len(owners) > 0 && !owners[keyCap] {
				names := make([]string, 0, len(owners))
				for c := range owners {
					names = append(names, c)
				}
				slices.Sort(names)
				add(a, "foreign-anchor", fixForeign(names[0], a.file))
				bad[id(a)] = true
				continue
			}
			if len(rw) >= 3 && a.overlap == 0 {
				add(a, "unrelated-anchor", fixUnrelated)
				bad[id(a)] = true
			}
		}
		skip := o.Many[key] || anchorsMany.MatchString(r.Block)
		weakFound := false
		if !skip && len(list) > max {
			unit := map[string]bool{}
			var dup []*fitAnchor
			for _, a := range list {
				u := a.file + "|" + a.Header
				if a.Header == "" {
					u = a.file + "|" + strconv.Itoa(a.Start) + "-" + strconv.Itoa(a.End)
				}
				if unit[u] {
					dup = append(dup, a)
				} else {
					unit[u] = true
				}
			}
			var weak []string
			for _, a := range list {
				if bad[id(a)] || slices.Contains(dup, a) {
					weak = append(weak, a.file+":"+strconv.Itoa(a.Line))
				}
			}
			weakFound = len(weak) > 0
			i := 0
			for _, a := range dup {
				if bad[id(a)] {
					continue
				}
				if i == 0 {
					add(a, "over-anchored", fixOverAnchored(len(list), max, weak))
				} else {
					add(a, "over-anchored", fixAgain)
				}
				i++
			}
		}
		if !skip && len(list) > ceiling && !weakFound {
			first := list[0]
			out = append(out, &FitFinding{File: first.file, Line: first.Line, Key: key, Kind: "many-anchors", Info: true, Text: first.file + ":" + strconv.Itoa(first.Line) + ": `" + key + "`: " + fixMany(len(list))})
		}
	}
	perUnit := map[string][]*fitAnchor{}
	var unitOrder []string
	for _, a := range anchors {
		if _, ok := o.Reqs[a.Key]; !ok {
			continue
		}
		k := a.file + "|" + strconv.Itoa(a.Start) + "|" + strconv.Itoa(a.End)
		if _, ok := perUnit[k]; !ok {
			unitOrder = append(unitOrder, k)
		}
		perUnit[k] = append(perUnit[k], a)
	}
	for _, k := range unitOrder {
		list := perUnit[k]
		var keys []string
		for _, a := range list {
			if !slices.Contains(keys, a.Key) {
				keys = append(keys, a.Key)
			}
		}
		if len(keys) <= crowd || list[0].unitLines > 60 {
			continue
		}
		ranked := slices.Clone(list)
		slices.SortStableFunc(ranked, func(x, y *fitAnchor) int {
			if x.overlap != y.overlap {
				return y.overlap - x.overlap
			}
			return x.Line - y.Line
		})
		keep := map[string]bool{}
		for _, a := range ranked[:crowd] {
			keep[a.Key] = true
		}
		for _, a := range list {
			if !keep[a.Key] && !bad[id(a)] {
				add(a, "crowded-unit", fixCrowded(len(keys)))
			}
		}
	}
	// the last marker of a requirement is never removable
	slices.SortStableFunc(out, func(a, b *FitFinding) int {
		if c := strings.Compare(a.File, b.File); c != 0 {
			return c
		}
		return a.Line - b.Line
	})
	removing := map[string]int{}
	res := make([]FitFinding, 0, len(out))
	for _, x := range out {
		if x.Remove {
			n := removing[x.Key]
			if n+1 >= len(byKey[x.Key]) {
				x.Remove = false
				x.Text += ". It is the last anchor of the requirement: move it instead of removing it"
			} else {
				removing[x.Key] = n + 1
			}
		}
		res = append(res, *x)
	}
	return res
}

func max2(a, b int) int {
	if a > b {
		return a
	}
	return b
}

var (
	removeLead = regexp.MustCompile(`^\s*(?://+!?|#+|/\*+!?|\*+|-{2,}|;+|<!--|%+|\{#|"""|''')?\s*`)
	removeTail = regexp.MustCompile(`\s*(?:\*+/|-->|#\}|"""|''')?\s*$`)
	keyLeft    = regexp.MustCompile(`^@spec\s*[,;]?\s*(?:[\w-]+/[\w-]+)`)
	bareSpec   = regexp.MustCompile(`^@spec\s*[,;:]?\s*`)
	specComma  = regexp.MustCompile(`^@spec\s+,\s*`)
	trailLead  = regexp.MustCompile(`\s*(?://+|#+|-{2,}|;+|%+)\s*$`)
	keyChar    = func(c byte) bool {
		return c == '_' || c == '-' || c == '/' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
)

// keyIndex finds key in s as a whole key (not part of a longer key): -1 when absent.
func keyIndex(s, key string) int {
	for from := 0; ; {
		i := strings.Index(s[from:], key)
		if i < 0 {
			return -1
		}
		i += from
		j := i + len(key)
		if (i == 0 || !keyChar(s[i-1])) && (j == len(s) || !keyChar(s[j])) {
			return i
		}
		from = i + 1
	}
}

// RemovePick is a marker key to delete from a file.
type RemovePick struct {
	File string
	Line int
	Key  string
}

// RemoveMarkers deletes the given markers from the texts and returns the changed texts. A comment line that holds only the
// marker goes away whole; a marker among other keys loses just its key; code lines are never touched.
func RemoveMarkers(texts map[string]string, picks []RemovePick) map[string]string {
	out := map[string]string{}
	for file, text := range texts {
		var mine []RemovePick
		for _, p := range picks {
			if p.File == file {
				mine = append(mine, p)
			}
		}
		if len(mine) == 0 {
			continue
		}
		eol := "\n"
		if strings.Contains(text, "\r\n") {
			eol = "\r\n"
		}
		lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
		drop := map[int]bool{}
		for _, p := range mine {
			if p.Line < 1 || p.Line > len(lines) {
				continue
			}
			l := lines[p.Line-1]
			at := strings.Index(l, "@spec")
			if at < 0 {
				continue
			}
			head, rest := l[:at], l[at:]
			ki := keyIndex(rest, p.Key)
			if ki < 0 {
				continue
			}
			rest = cutKey(rest, ki, ki+len(p.Key))
			if !keyLeft.MatchString(rest) {
				rest = dropBareSpec(rest)
			}
			left := head + specComma.ReplaceAllString(rest, "@spec ")
			bare := removeTail.ReplaceAllString(removeLead.ReplaceAllString(left, ""), "")
			if strings.TrimSpace(bare) == "" {
				drop[p.Line-1] = true
				continue
			}
			if strings.TrimSpace(removeLead.ReplaceAllString(head, "")) != "" {
				lines[p.Line-1] = strings.TrimRight(trailLead.ReplaceAllString(left, ""), " \t")
			} else {
				lines[p.Line-1] = strings.TrimRight(left, " \t")
			}
		}
		var kept []string
		for i, l := range lines {
			if !drop[i] {
				kept = append(kept, l)
			}
		}
		out[file] = strings.Join(kept, eol)
	}
	return out
}

func keyFollows(s string) bool {
	i := 0
	for i < len(s) && (keyChar(s[i]) && s[i] != '/') {
		i++
	}
	return i > 0 && i < len(s) && s[i] == '/'
}

// cutKey removes rest[ls:le] with its separating comma: a comma on both sides (before another key) collapses to one.
func cutKey(rest string, ls, le int) string {
	start, end := ls, le
	i := ls
	for i > 0 && (rest[i-1] == ' ' || rest[i-1] == '\t') {
		i--
	}
	hasLead := i > 0 && rest[i-1] == ','
	if hasLead {
		i--
		for i > 0 && (rest[i-1] == ' ' || rest[i-1] == '\t') {
			i--
		}
		start = i
	}
	j := le
	for j < len(rest) && (rest[j] == ' ' || rest[j] == '\t') {
		j++
	}
	hasTrail := false
	if j < len(rest) && rest[j] == ',' {
		k := j + 1
		for k < len(rest) && (rest[k] == ' ' || rest[k] == '\t') {
			k++
		}
		if keyFollows(rest[k:]) {
			hasTrail, end = true, k
		}
	}
	mid := ""
	if hasLead && hasTrail {
		mid = ", "
	}
	return rest[:start] + mid + rest[end:]
}

// dropBareSpec removes a `@spec` that has no key left, with a separator dash or colon after it.
func dropBareSpec(rest string) string {
	loc := bareSpec.FindStringIndex(rest)
	if loc == nil {
		return rest
	}
	r := rest[loc[1]:]
	switch {
	case strings.HasPrefix(r, "\u2013"), strings.HasPrefix(r, "\u2014"):
		_, n := utf8.DecodeRuneInString(r)
		r = strings.TrimLeft(r[n:], " \t")
	case strings.HasPrefix(r, ":"):
		r = strings.TrimLeft(r[1:], " \t")
	case strings.HasPrefix(r, "-") && !strings.HasPrefix(r, "--") && !strings.HasPrefix(r, "->"):
		r = strings.TrimLeft(r[1:], " \t")
	}
	return r
}
