// Package frontmatter reads the small YAML subset used at the top of Markdown files:
// scalars, inline lists and indented block lists.
package frontmatter

import (
	"regexp"
	"strings"
)

// Map is parsed front matter. A value is a string or a []string.
type Map map[string]any

// Str is the value as text. A missing key is "". A list is joined with commas.
func (d Map) Str(k string) string {
	switch v := d[k].(type) {
	case string:
		return v
	case []string:
		return strings.Join(v, ",")
	}
	return ""
}

// List is the value as a list. A scalar becomes a one-element list.
func (d Map) List(k string) []string {
	switch v := d[k].(type) {
	case []string:
		return v
	case string:
		if v != "" {
			return []string{v}
		}
	}
	return nil
}

// fence is the only front-matter delimiter. The text is LF-normalised first.
var fence = regexp.MustCompile(`(?s)^---\n(.*?)\n---\n?(.*)$`)

var (
	comment = regexp.MustCompile(`\s+#\s.*$`)
	keyRE   = regexp.MustCompile(`^([A-Za-z_][\w-]*):\s*(.*)$`)
	itemRE  = regexp.MustCompile(`^\s+-\s+(.*)$`)
	quotes  = regexp.MustCompile(`^["']|["']$`)
)

func unquote(s string) string { return quotes.ReplaceAllString(s, "") }

// Split returns the front-matter block and the body. The bool is false when text has no front matter.
// On failure body is text with CRLF turned into LF, which is what callers that keep the whole file expect.
func Split(text string) (matter, body string, ok bool) {
	t := strings.ReplaceAll(text, "\r\n", "\n")
	m := fence.FindStringSubmatch(t)
	if m == nil {
		return "", t, false
	}
	return m[1], m[2], true
}

// Parse reads front matter. The bool is false when text has none; body is still the LF-normalised text.
func Parse(text string) (Map, string, bool) {
	matter, body, ok := Split(text)
	if !ok {
		return Map{}, body, false
	}
	d := Map{}
	key := ""
	for raw := range strings.SplitSeq(matter, "\n") {
		line := strings.TrimRight(comment.ReplaceAllString(raw, ""), " \t")
		if k := keyRE.FindStringSubmatch(line); k != nil {
			key = k[1]
			v := strings.TrimSpace(k[2])
			switch {
			case v == "":
				d[key] = ""
			case strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]"):
				var list []string
				for x := range strings.SplitSeq(v[1:len(v)-1], ",") {
					if x = unquote(strings.TrimSpace(x)); x != "" {
						list = append(list, x)
					}
				}
				d[key] = list
			default:
				d[key] = unquote(v)
			}
			continue
		}
		if k := itemRE.FindStringSubmatch(line); k != nil && key != "" {
			list, _ := d[key].([]string)
			d[key] = append(list, unquote(strings.TrimSpace(k[1])))
		}
	}
	return d, body, true
}

// Status is the status scalar, matched without case. The bool is false when the key is absent.
func Status(text string) (string, bool) {
	m, _, ok := Parse(text)
	if !ok {
		return "", false
	}
	for k, v := range m {
		if strings.EqualFold(k, "status") {
			s, _ := v.(string)
			return s, true
		}
	}
	return "", false
}
