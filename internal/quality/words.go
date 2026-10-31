package quality

import (
	"regexp"
	"strings"
)

// wordRE matches a list of alternatives as whole words: not preceded by [\w$.\-/] and not followed by [\w$\-/]
// (an identifier, test id, path or quoted UI text is not a keyword). RE2 has no lookaround, so the boundaries are
// checked by hand.
type wordRE struct{ re *regexp.Regexp }

func w(alts string) wordRE { return wordRE{regexp.MustCompile(`(?i)(?:` + alts + `)`)} }

func isWordish(c byte) bool {
	return c == '_' || c == '$' || c == '-' || c == '/' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// all returns every whole-word match.
func (x wordRE) all(s string) []string {
	var out []string
	for pos := 0; pos <= len(s); {
		loc := x.re.FindStringIndex(s[pos:])
		if loc == nil {
			break
		}
		a, b := pos+loc[0], pos+loc[1]
		okL := a == 0 || (!isWordish(s[a-1]) && s[a-1] != '.')
		okR := b == len(s) || !isWordish(s[b])
		if okL && okR && b > a {
			out = append(out, s[a:b])
			pos = b
			continue
		}
		pos = a + 1
	}
	return out
}

func (x wordRE) find(s string) string {
	if m := x.all(s); len(m) > 0 {
		return m[0]
	}
	return ""
}

func (x wordRE) match(s string) bool { return x.find(s) != "" }

var (
	codeSpanRE = regexp.MustCompile("`[^`]*`")
	quotedRE   = regexp.MustCompile(`"[^"]*"|“[^”]*”`)
	mdLinkRE   = regexp.MustCompile(`\[[^\]]*\]\([^)]*\)`)
)

// prose is a statement with code spans, quoted UI text and links removed, so only prose words are matched.
func prose(s string) string {
	s = codeSpanRE.ReplaceAllString(s, " ")
	s = quotedRE.ReplaceAllString(s, " ")
	return mdLinkRE.ReplaceAllString(s, " ")
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func splitWords(t string) []string {
	var out []string
	for _, x := range nonAlnum.Split(strings.ToLower(t), -1) {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

// trimPlural is `w.replace(/([^s])s$/, '$1')`.
func trimPlural(x string) string {
	if n := len(x); n >= 2 && x[n-1] == 's' && x[n-2] != 's' {
		return x[:n-1]
	}
	return x
}
