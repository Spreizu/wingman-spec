package trace

import (
	"cmp"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Rewrite is one marker key a RENAMED delta entry rewrote.
type Rewrite struct {
	File string `json:"file"`
	Line int    `json:"line"`
	From string `json:"from"`
	To   string `json:"to"`
}

// RenameMarkers rewrites the @spec markers (code and tests) of each requirement a RENAMED entry of the change renames to
// the new key. Only marker lines change; it is idempotent. Test tags name scenarios, which a rename keeps.
func (c Ctx) RenameMarkers(changeDir string) ([]Rewrite, error) {
	to := map[string]string{}
	for _, d := range Deltas(changeDir) {
		for _, rn := range d.Renames {
			if rn.FromSlug != rn.ToSlug {
				to[d.Cap+"/"+rn.FromSlug] = d.Cap + "/" + rn.ToSlug
			}
		}
	}
	if len(to) == 0 {
		return nil, nil
	}
	byFile := map[string][]int{}
	for _, m := range c.ScanAnchors(nil) {
		if _, ok := to[m.Key]; ok {
			byFile[m.File] = append(byFile[m.File], m.Line)
		}
	}
	var out []Rewrite
	for f, lines := range byFile {
		p := filepath.Join(c.R.Code, f)
		b, err := os.ReadFile(p)
		if err != nil {
			return out, err
		}
		ls := strings.Split(string(b), "\n")
		for _, n := range lines {
			for from, nk := range to {
				re := regexp.MustCompile(`(^|[^a-z0-9/-])` + regexp.QuoteMeta(from) + `($|[^a-z0-9-])`)
				if re.MatchString(ls[n-1]) {
					ls[n-1] = re.ReplaceAllString(ls[n-1], "${1}"+nk+"${2}")
					out = append(out, Rewrite{f, n, from, nk})
				}
			}
		}
		st, _ := os.Stat(p)
		if err := os.WriteFile(p, []byte(strings.Join(ls, "\n")), st.Mode().Perm()); err != nil {
			return out, err
		}
	}
	slices.SortFunc(out, func(a, b Rewrite) int { return cmp.Or(cmp.Compare(a.File, b.File), cmp.Compare(a.Line, b.Line)) })
	return out, nil
}
