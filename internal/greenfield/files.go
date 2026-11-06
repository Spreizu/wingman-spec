// Package greenfield is the new-product flow: the project-mode guard, the state-driven `greenfield status`, the roadmap
// check and the handover gate. Nothing here calls an agent or the network. Every write is one small file; no shared
// index exists: status, order and coverage are derived from the files each time.
package greenfield

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/Spreizu/wingman-spec/internal/frontmatter"
	"github.com/Spreizu/wingman-spec/internal/layout"
)

// ExitRefused is the exit code of a command the project-mode guard refuses: nothing was written.
const ExitRefused = 6

// yamlCommentRE keeps a trailing comment on a front-matter line.
var yamlCommentRE = regexp.MustCompile(`^[^:]+:[^#]*?([ \t]*#.*)?$`)

// Run is how the texts name the CLI (the shim init writes).
const Run = ".wingman-spec/bin/wingman-spec"

// Project is one specs root with its paths.
type Project struct {
	Root *layout.Root
	S    string // the specs root (the .wingman-spec folder next to code, or the specs repository)
	Now  func() time.Time
}

// New wraps a root.
func New(r *layout.Root) *Project { return &Project{Root: r, S: r.Specs, Now: time.Now} }

func (p *Project) path(parts ...string) string {
	return filepath.Join(append([]string{p.S}, parts...)...)
}

// G is a path in the greenfield folder.
func (p *Project) G(parts ...string) string {
	return p.path(append([]string{"greenfield"}, parts...)...)
}

// Rel is a path as the texts show it (relative to the code root, slash separated).
func (p *Project) Rel(abs string) string { return filepath.ToSlash(p.Root.Rel(abs)) }

func (p *Project) today() string { return p.Now().UTC().Format("2006-01-02") }

func isDir(d string) bool { st, err := os.Stat(d); return err == nil && st.IsDir() }

// ls lists the visible names of d (with ext when given), sorted.
func ls(d, ext string) []string {
	ents, err := os.ReadDir(d)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasPrefix(n, ".") || (ext != "" && !strings.HasSuffix(n, ext)) {
			continue
		}
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:])[:16] }

// natural compares like localeCompare with numeric: digit runs by value, the rest case-insensitively.
func natural(a, b string) int {
	for a != "" && b != "" {
		da, db := unicode.IsDigit(rune(a[0])), unicode.IsDigit(rune(b[0]))
		if da && db {
			i, j := 0, 0
			for i < len(a) && unicode.IsDigit(rune(a[i])) {
				i++
			}
			for j < len(b) && unicode.IsDigit(rune(b[j])) {
				j++
			}
			x, _ := strconv.Atoi(a[:i])
			y, _ := strconv.Atoi(b[:j])
			if x != y {
				if x < y {
					return -1
				}
				return 1
			}
			a, b = a[i:], b[j:]
			continue
		}
		ca, cb := unicode.ToLower(rune(a[0])), unicode.ToLower(rune(b[0]))
		if ca != cb {
			if ca < cb {
				return -1
			}
			return 1
		}
		a, b = a[1:], b[1:]
	}
	return len(a) - len(b)
}

// FM is parsed front matter. A value is a string or a []string.
type FM = frontmatter.Map

// SetFM sets keys in a file's front matter, byte-preserving: only the lines of the given keys change (a trailing
// comment on such a line is kept); other keys, comments, quoting, blank lines, key order, the body and the line
// endings stay as written. A missing key is added before the closing `---`.
func SetFM(text string, keys []string, vals map[string]string) string {
	var lines []string
	for rest := text; rest != ""; {
		i := strings.Index(rest, "\n")
		if i < 0 {
			lines = append(lines, rest)
			break
		}
		lines = append(lines, rest[:i+1])
		rest = rest[i+1:]
	}
	strip := func(l string) string { return strings.TrimSuffix(strings.TrimSuffix(l, "\n"), "\r") }
	if len(lines) == 0 || strip(lines[0]) != "---" {
		var head strings.Builder
		for _, k := range keys {
			head.WriteString(k + ": " + vals[k] + "\n")
		}
		return "---\n" + head.String() + "---\n" + text
	}
	end := len(lines)
	for i := 1; i < len(lines); i++ {
		if strip(lines[i]) == "---" {
			end = i
			break
		}
	}
	eol := "\n"
	if strings.HasSuffix(lines[0], "\r\n") {
		eol = "\r\n"
	}
	for _, k := range keys {
		v := vals[k]
		found := -1
		for n := 1; n < end; n++ {
			if strings.HasPrefix(lines[n], k+":") {
				found = n
				break
			}
		}
		if found >= 0 {
			l := lines[found]
			c := ""
			if m := yamlCommentRE.FindStringSubmatch(strip(l)); m != nil {
				c = m[1]
			}
			le := eol
			switch {
			case strings.HasSuffix(l, "\r\n"):
				le = "\r\n"
			case strings.HasSuffix(l, "\n"):
				le = "\n"
			}
			lines[found] = k + ": " + v + c + le
		} else {
			lines = slices.Insert(lines, end, k+": "+v+eol)
			end++
		}
	}
	return strings.Join(lines, "")
}
