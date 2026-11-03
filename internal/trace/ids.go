package trace

import (
	"cmp"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// idAlphabet is the 32 characters of a requirement ID: no 0, O, 1 or I, which read alike.
const idAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

var (
	// IDLineRE is a requirement's `ID: <CAP>-XXXX` line (under its SHALL sentence, before the first scenario).
	IDLineRE = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?\**ID\**:\s*(.*?)\s*$`)
	idRE     = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_-]*-[A-HJ-NP-Z2-9]{4}$`)
	nextHead = regexp.MustCompile(`^#{2,4}\s`)
)

// CanonID is the canonical (upper-case) form of an ID as written.
func CanonID(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

// ValidID reports whether id is <PREFIX>-XXXX with XXXX from the ID alphabet.
func ValidID(id string) bool { return idRE.MatchString(id) }

// NewID draws a random ID for a requirement of capability cap that taken does not hold, and adds it to taken.
func NewID(cap string, taken map[string]bool) string {
	for {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		id := []byte(strings.ToUpper(cap) + "-")
		for _, x := range b {
			id = append(id, idAlphabet[int(x)%len(idAlphabet)]) // 256 is a multiple of 32: unbiased
		}
		if s := string(id); !taken[s] {
			taken[s] = true
			return s
		}
	}
}

func idOf(r *Requirement) string {
	if r == nil || r.ID == nil {
		return ""
	}
	return CanonID(*r.ID)
}

// idUse is one place an ID appears: a living requirement, or an entry of an archived or active change.
type idUse struct{ Key, Op, Where string }

// idUses lists every ID the specs ever carried: the living specs, then the archived and the active changes' deltas.
// An ID that only the archive holds is retired: a REMOVED entry recorded it, and it is never handed out again.
func (c Ctx) idUses() map[string][]idUse {
	out := map[string][]idUse{}
	living := Living(c.Specs())
	for _, k := range living.Keys() {
		if r, _ := living.Get(k); idOf(r) != "" {
			out[idOf(r)] = append(out[idOf(r)], idUse{k, "LIVING", ""})
		}
	}
	add := func(dir, where string) {
		for _, d := range Deltas(dir) {
			for _, r := range d.Reqs {
				if id := idOf(r); id != "" {
					out[id] = append(out[id], idUse{d.Cap + "/" + r.Slug, r.Op, where})
				}
			}
		}
	}
	for _, a := range ArchiveOrder(c.R.Archive()) {
		add(filepath.Join(c.R.Archive(), a), "archive/"+a)
	}
	for _, n := range c.ActiveChanges() {
		add(c.R.Change(n), n)
	}
	return out
}

// IDAliases maps each requirement ID to its key: the living ones, moved by the active changes' RENAMED entries, and
// the IDs the active changes add. `@spec` markers may name a requirement by either.
func (c Ctx) IDAliases() map[string]string {
	m := map[string]string{}
	living := Living(c.Specs())
	for _, k := range living.Keys() {
		if r, _ := living.Get(k); idOf(r) != "" {
			m[idOf(r)] = k
		}
	}
	for _, n := range c.ActiveChanges() {
		for _, d := range Deltas(c.R.Change(n)) {
			for _, rn := range d.Renames {
				for id, k := range m {
					if k == d.Cap+"/"+rn.FromSlug {
						m[id] = d.Cap + "/" + rn.ToSlug
					}
				}
			}
			for _, r := range d.Reqs {
				if id := idOf(r); id != "" && r.Op != "REMOVED" {
					m[id] = d.Cap + "/" + r.Slug
				}
			}
		}
	}
	return m
}

// livingIDs is what an entry of the change starts from: the ID of each delta key's living requirement (through the
// change's RENAMED entries).
func (c Ctx) livingIDs(deltas []Delta) func(cap, slug string) string {
	living := Living(c.Specs())
	from := map[string]string{}
	for _, d := range deltas {
		for _, rn := range d.Renames {
			from[d.Cap+"/"+rn.ToSlug] = d.Cap + "/" + rn.FromSlug
		}
	}
	return func(cap, slug string) string {
		k := cap + "/" + slug
		if f, ok := from[k]; ok {
			k = f
		}
		r, _ := living.Get(k)
		return idOf(r)
	}
}

// IDLint checks the change's `ID:` lines: the canonical form, the format and prefix of a new ID, a MODIFIED or REMOVED
// requirement keeping its living ID, and no ID taken by another requirement or retired (an ID is never reused; a
// requirement moved to another capability keeps its ID when the same change REMOVEs it there).
func (c Ctx) IDLint(changeDir string) []Problem {
	ds := Deltas(changeDir)
	was := c.livingIDs(ds)
	uses := c.idUses()
	self := filepath.Base(changeDir)
	removed, seen := map[string]bool{}, map[string]string{}
	for _, d := range ds {
		for _, r := range d.Reqs {
			if r.Op == "REMOVED" {
				removed[cmp.Or(idOf(r), was(d.Cap, r.Slug))] = true
			}
		}
	}
	var out []Problem
	for _, d := range ds {
		rel := filepath.ToSlash(relTo(changeDir, d.File))
		for _, r := range d.Reqs {
			key, id, old := d.Cap+"/"+r.Slug, idOf(r), was(d.Cap, r.Slug)
			bad := func(f string, a ...any) {
				out = append(out, Problem{Severity: "error", Kind: "requirement-id", File: rel, Line: r.Line,
					Text: fmt.Sprintf("%s:%d: requirement %q: ", rel, r.Line, r.Name) + fmt.Sprintf(f, a...)})
			}
			switch {
			case id != "" && *r.ID != id && ValidID(id):
				bad("write the ID as %s (`lint --fix`)", id)
				continue
			case id != "" && !ValidID(id):
				bad("`ID: %s` is not an ID: <CAPABILITY>-XXXX, 4 of %s (drop the line; `lint --fix` assigns one)", *r.ID, idAlphabet)
				continue
			case old != "" && r.Op != "ADDED" && id == "":
				bad("its living ID is %s and an ID never changes: keep the line `ID: %s` (`lint --fix` adds it)", old, old)
				continue
			case old != "" && r.Op != "ADDED" && id != old:
				bad("its living ID is %s, not %s: an ID never changes", old, id)
				continue
			case id == "" || r.Op == "REMOVED" || id == old:
				continue
			}
			if k, dup := seen[id]; dup {
				bad("ID %s is also %s's in this change", id, k)
				continue
			}
			seen[id] = key
			if moved := removed[id]; !moved {
				if p := strings.ToUpper(d.Cap); id[:len(id)-5] != p {
					bad("a new ID starts with %s- (the capability folder); `lint --fix` assigns one", p)
					continue
				}
			}
			where := func(ok func(idUse) bool) (idUse, bool) {
				i := slices.IndexFunc(uses[id], ok)
				if i < 0 {
					return idUse{}, false
				}
				return uses[id][i], true
			}
			_, archived := where(func(u idUse) bool { return strings.HasPrefix(u.Where, "archive/") })
			if u, ok := where(func(u idUse) bool { return u.Where == "" }); ok && !removed[id] {
				bad("ID %s is already %s's: drop the line (`lint --fix` assigns a new one)", id, u.Key)
			} else if !ok && archived && !removed[id] {
				bad("ID %s is retired (an archived change used it): an ID is never reused; drop the line (`lint --fix` assigns a new one)", id)
			} else if u, ok := where(func(u idUse) bool {
				return u.Where != self && u.Where != "" && !strings.HasPrefix(u.Where, "archive/") && u.Op != "REMOVED"
			}); ok {
				bad("ID %s is also %s's in the active change %q", id, u.Key, u.Where)
			}
		}
	}
	return out
}

// AssignIDs is the ID part of `lint --fix`: an ADDED requirement without an `ID:` line gets a new random one, a
// MODIFIED or REMOVED one gets its living ID back, and a lower-case ID is upper-cased. It returns the lines it changed.
func (c Ctx) AssignIDs(changeDir string) (int, error) {
	ds := Deltas(changeDir)
	was := c.livingIDs(ds)
	taken := map[string]bool{}
	for id := range c.idUses() {
		taken[id] = true
	}
	n := 0
	for _, d := range ds {
		b, err := os.ReadFile(d.File)
		if err != nil {
			return n, err
		}
		ls := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
		k := 0
		for _, r := range slices.Backward(d.Reqs) {
			if r.ID != nil {
				if id := idOf(r); id != *r.ID && ValidID(id) {
					ls[r.idAt] = strings.Replace(ls[r.idAt], *r.ID, id, 1)
					k++
				}
				continue
			}
			id := was(d.Cap, r.Slug)
			if id == "" && r.Op == "ADDED" {
				id = NewID(d.Cap, taken)
			}
			if id == "" {
				continue
			}
			at := r.Line - 1
			for j := r.Line; j < len(ls) && !nextHead.MatchString(ls[j]); j++ {
				if strings.TrimSpace(ls[j]) != "" {
					at = j
				}
			}
			ls = slices.Insert(ls, at+1, "ID: "+id)
			k++
		}
		if k == 0 {
			continue
		}
		if err := os.WriteFile(d.File, []byte(strings.Join(ls, "\n")), 0o644); err != nil {
			return n, err
		}
		n += k
	}
	return n, nil
}
