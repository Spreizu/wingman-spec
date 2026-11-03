package quality

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	reqHeadFix = regexp.MustCompile(`^###\s+Requirement:\s*`)
	whyLineFix = regexp.MustCompile(`(?i)^\s*Why:`)
	h2Fix      = regexp.MustCompile(`^##\s+`)
	purposeFix = regexp.MustCompile(`(?i)^##\s+Purpose\s*$`)
)

// Fix applies mechanical repairs to the change's specs: a missing Why: line and a missing ## Purpose heading.
func Fix(changeDir string) (int, error) {
	n := 0
	specs := filepath.Join(changeDir, "specs")
	for _, sf := range SpecFiles(specs) {
		b, err := os.ReadFile(sf.File)
		if err != nil {
			return n, err
		}
		text := strings.ReplaceAll(string(b), "\r\n", "\n")
		next, k := fixSpec(text)
		if k == 0 {
			continue
		}
		if err := os.WriteFile(sf.File, []byte(next), 0o644); err != nil {
			return n, err
		}
		n += k
	}
	return n, nil
}

func fixSpec(text string) (string, int) {
	ls := strings.Split(text, "\n")
	n := 0
	hasPurpose := false
	for _, l := range ls {
		if purposeFix.MatchString(l) {
			hasPurpose = true
			break
		}
	}
	if !hasPurpose {
		insert := 0
		for i, l := range ls {
			if strings.HasPrefix(l, "# ") || h2Fix.MatchString(l) {
				insert = i + 1
				for insert < len(ls) && strings.TrimSpace(ls[insert]) == "" {
					insert++
				}
				break
			}
		}
		block := []string{"## Purpose", "<fill in>", ""}
		ls = append(ls[:insert], append(block, ls[insert:]...)...)
		n++
	}
	why := regexp.MustCompile(`(?i)^\s*Why:`)
	out := make([]string, 0, len(ls)+8)
	for i := 0; i < len(ls); i++ {
		out = append(out, ls[i])
		if !reqHeadFix.MatchString(ls[i]) {
			continue
		}
		j := i + 1
		found := false
		for j < len(ls) && !strings.HasPrefix(ls[j], "### ") && !strings.HasPrefix(ls[j], "## ") {
			if why.MatchString(ls[j]) {
				found = true
				break
			}
			if strings.HasPrefix(ls[j], "#### ") {
				break
			}
			j++
		}
		if found {
			continue
		}
		k := i + 1
		for k < len(ls) && strings.TrimSpace(ls[k]) == "" {
			out = append(out, ls[k])
			k++
		}
		if k < len(ls) && k > i+1 {
			// SHALL (or statement) already copied? we only copied blanks.
		}
		if k < len(ls) && !strings.HasPrefix(ls[k], "#") && !why.MatchString(ls[k]) {
			out = append(out, ls[k])
			i = k
		}
		out = append(out, "Why: <fill in>")
		n++
	}
	return strings.Join(out, "\n"), n
}

func init() { _ = whyLineFix }
