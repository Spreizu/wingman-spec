package trace

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Spreizu/wingman-spec/internal/anchors"
)

// ArchiveOrder lists the archived change folders, oldest first: by archived.json's archived_at, else by the folder name.
func ArchiveOrder(archiveDir string) []string {
	ents, err := os.ReadDir(archiveDir)
	if err != nil {
		return nil
	}
	type item struct {
		name string
		at   time.Time
	}
	var items []item
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		it := item{name: e.Name()}
		var rec struct {
			ArchivedAt string `json:"archived_at"`
		}
		if b, err := os.ReadFile(filepath.Join(archiveDir, e.Name(), "archived.json")); err == nil && json.Unmarshal(b, &rec) == nil {
			if t, err := time.Parse(time.RFC3339, rec.ArchivedAt); err == nil {
				it.at = t
			}
		}
		if it.at.IsZero() && len(it.name) >= 15 {
			if t, err := time.ParseInLocation("2006-01-02-1504", it.name[:15], time.Local); err == nil {
				it.at = t
			} else if t, err := time.ParseInLocation("2006-01-02", it.name[:10], time.Local); err == nil {
				it.at = t
			}
		}
		items = append(items, it)
	}
	slices.SortStableFunc(items, func(a, b item) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		return strings.Compare(a.name, b.name)
	})
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.name
	}
	return out
}

// ArchivedExpectation replays the archived changes in order: requirement keys that should be in the living specs, with
// the archive that added them. pendingDir (a change being synced) is replayed last.
func (c Ctx) ArchivedExpectation(pendingDir string) ([]string, map[string]string) {
	exp := map[string]string{}
	var order []string
	set := func(k, a string) {
		if _, ok := exp[k]; !ok {
			order = append(order, k)
		}
		exp[k] = a
	}
	del := func(k string) {
		if _, ok := exp[k]; ok {
			delete(exp, k)
			order = slices.DeleteFunc(order, func(x string) bool { return x == k })
		}
	}
	replay := func(d Delta, a string) {
		for _, rn := range d.Renames {
			if _, ok := exp[d.Cap+"/"+rn.FromSlug]; ok {
				del(d.Cap + "/" + rn.FromSlug)
				set(d.Cap+"/"+rn.ToSlug, a)
			}
		}
		for _, r := range d.Reqs {
			k := d.Cap + "/" + r.Slug
			switch r.Op {
			case "ADDED":
				set(k, a)
			case "REMOVED":
				del(k)
			}
		}
	}
	for _, a := range ArchiveOrder(c.R.Archive()) {
		for _, d := range Deltas(filepath.Join(c.R.Archive(), a)) {
			replay(d, a)
		}
	}
	if pendingDir != "" {
		for _, d := range Deltas(pendingDir) {
			replay(d, filepath.Base(pendingDir))
		}
	}
	return order, exp
}

// Observed entries (behaviour seen in code but not confirmed) live in observed/<capability>.md next to specs/.
var (
	ObservedKinds = []string{"contradicts-doc", "suspected-bug", "debug-leftover", "incidental", "unclear", "untested"}
	confirmKinds  = []string{"test", "doc", "owner"}
	obsHeadRE     = regexp.MustCompile(`^##\s+(.+?)\s*$`)
	obsFieldRE    = regexp.MustCompile(`(?i)^\s*[-*]\s*(Observed|Why unconfirmed|Owner|To confirm)\s*:\s*(.*?)\s*$`)
	contRE        = regexp.MustCompile(`^\s{2,}\S`)
	bulletStartRE = regexp.MustCompile(`^\s*[-*]\s`)
)

// ObservedEntry is one entry of observed/<capability>.md.
type ObservedEntry struct {
	Cap, Slug, File               string
	Line                          int
	Observed, Why, Owner, Confirm string
}

// ObservedDir is the directory of observed/<capability>.md.
func (c Ctx) ObservedDir() string { return filepath.Join(c.R.Specs, "observed") }

// ObservedEntries reads every observed entry.
func (c Ctx) ObservedEntries() []ObservedEntry {
	var out []ObservedEntry
	for _, sf := range SpecFilesOf(c.ObservedDir()) {
		var e *ObservedEntry
		last := ""
		flush := func() {
			if e != nil {
				out = append(out, *e)
			}
		}
		for i, l := range strings.Split(strings.ReplaceAll(readIf(sf.File), "\r\n", "\n"), "\n") {
			if m := obsHeadRE.FindStringSubmatch(l); m != nil {
				flush()
				e = &ObservedEntry{Cap: sf.Cap, Slug: slugOf(m[1]), File: sf.File, Line: i + 1}
				last = ""
				continue
			}
			if e == nil {
				continue
			}
			if m := obsFieldRE.FindStringSubmatch(l); m != nil {
				last = strings.ToLower(m[1])
				*e.field(last) = m[2]
				continue
			}
			if last != "" && contRE.MatchString(l) {
				*e.field(last) += " " + strings.TrimSpace(l)
			} else if bulletStartRE.MatchString(l) || strings.TrimSpace(l) == "" {
				last = ""
			}
		}
		flush()
	}
	return out
}

func (e *ObservedEntry) field(name string) *string {
	switch name {
	case "observed":
		return &e.Observed
	case "why unconfirmed":
		return &e.Why
	case "owner":
		return &e.Owner
	default:
		return &e.Confirm
	}
}

func observedProblem(e ObservedEntry) string {
	var missing []string
	for _, f := range []struct{ v, n string }{{e.Observed, "Observed"}, {e.Why, "Why unconfirmed"}, {e.Owner, "Owner"}, {e.Confirm, "To confirm"}} {
		if f.v == "" {
			missing = append(missing, "`"+f.n+":`")
		}
	}
	if len(missing) > 0 {
		return "missing " + strings.Join(missing, ", ")
	}
	why := strings.ToLower(e.Why)
	if !slices.ContainsFunc(ObservedKinds, func(k string) bool { return strings.HasPrefix(why, k) }) {
		return "`Why unconfirmed:` starts with none of " + strings.Join(ObservedKinds, " | ")
	}
	return ""
}

func confirmedProblem(r *Requirement) string {
	if r.Confirmed == nil {
		return "has no `Confirmed:` line"
	}
	for _, k := range confirmKinds {
		if regexp.MustCompile(`(?i)^` + k + `\b\s*\S`).MatchString(*r.Confirmed) {
			return ""
		}
	}
	return fmt.Sprintf("`Confirmed: %s` must start with test, doc or owner and name the evidence", cut(*r.Confirmed, 40))
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func slugOf(s string) string {
	return strings.Trim(nonAlnumRE.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// Gap is one drift finding.
type Gap struct {
	Key       string   `json:"key"`
	Type      string   `json:"type"`
	Subject   string   `json:"subject"`
	Text      string   `json:"text"`
	Hint      string   `json:"hint,omitempty"`
	Files     []string `json:"files"`
	Line      int      `json:"line,omitempty"`
	Severity  string   `json:"severity,omitempty"` // "" = error; warn | info are advisory
	Accepted  string   `json:"accepted,omitempty"`
	Fit       string   `json:"fit,omitempty"`
	Removable bool     `json:"removable,omitempty"`
	Commit    string   `json:"commit,omitempty"`
}

// DriftReport is the drift of the living specs against the code.
type DriftReport struct {
	Gaps         []Gap          `json:"gaps"`
	Open         []Gap          `json:"open"`
	Accepted     []Gap          `json:"accepted"`
	Counts       map[string]int `json:"counts"`
	Requirements int            `json:"requirements"`
	Facts        Facts          `json:"-"`
	Reqs         *Reqs          `json:"-"`
	Notes        []string       `json:"notes"`
	Observed     map[string]int `json:"observed"`
}

// Acceptable gap types: they belong to a requirement, so accepting one is an `Accepted:` line on it.
var Acceptable = []string{"unanchored-requirement", "untested-requirement", "stale-anchor"}

func gapRequirement(g Gap) string {
	if g.Type == "stale-anchor" {
		k, _, _ := strings.Cut(g.Subject, "@")
		return k
	}
	return g.Subject
}

// Drift reports the gaps between the living specs, the code anchors and the test tags. light computes only the gap types
// sync reads (no placement, fit or stale anchors).
func (c Ctx) Drift(pendingDir string, light bool) DriftReport {
	reqs := Living(c.Specs())
	facts := c.AnchorFacts(reqs)
	var gaps []Gap
	add := func(g Gap) {
		g.Key = g.Type + ":" + g.Subject
		if g.Files == nil {
			g.Files = []string{}
		}
		gaps = append(gaps, g)
	}
	for _, k := range reqs.keys {
		x := facts.Requirements[k]
		r := reqs.m[k]
		switch {
		case len(x.Code) == 0:
			add(Gap{Type: "unanchored-requirement", Subject: k, Text: fmt.Sprintf("requirement %q has no code anchor", r.Name), Hint: "put `@spec " + k + "` on the code that implements it (the code may have lost its marker when moved); if the code is gone, rebuild it test-first or retire the requirement in a change; if it is knowingly unanchored: `wingman-spec drift decide unanchored-requirement:" + k + " --accept --note \"<why>\"`"})
		case len(x.Tests) == 0:
			cp, _, _ := strings.Cut(k, "/")
			add(Gap{Type: "untested-requirement", Subject: k, Files: sortedKeys(x.Code), Text: fmt.Sprintf("requirement %q has code anchors but no test anchor (no test tagged for its scenarios, no @spec marker in a test)", r.Name), Hint: "tag a test `[" + cp + "/<scenario-slug>]` or put `@spec " + k + "` in it; if it is knowingly untested: `wingman-spec drift decide untested-requirement:" + k + " --accept --note \"<why>\"`"})
		}
	}
	seenOrphan := map[string]bool{}
	for _, u := range facts.Unresolved {
		id := u.Key + "@" + u.File
		if seenOrphan[id] {
			continue
		}
		seenOrphan[id] = true
		hint := "retarget or remove the marker"
		if n := Nearest(u.Key, reqs.Keys()); n != "" {
			hint += ": perhaps renamed to " + n
		}
		add(Gap{Type: "orphan-anchor", Subject: id, Files: []string{u.File}, Text: fmt.Sprintf("`@spec %s` in %s:%d points at a requirement that does not exist (removed, renamed or mistyped)", u.Key, u.File, u.Line), Hint: hint})
	}
	scKeys := make([]string, 0)
	for k := range scenarioIndex(reqs) {
		scKeys = append(scKeys, k)
	}
	slices.Sort(scKeys)
	for _, s := range facts.StaleTags {
		hint := "retarget or remove the tag"
		if n := Nearest(s.Tag, scKeys); n != "" {
			hint += ": perhaps renamed to [" + n + "]"
		}
		add(Gap{Type: "stale-test-tag", Subject: s.Tag, Files: s.Files, Text: fmt.Sprintf("test tag [%s] in %s: %s", s.Tag, strings.Join(s.Files, ", "), s.Why), Hint: hint})
	}
	for _, k := range reqs.keys {
		r := reqs.m[k]
		if !r.Baseline || r.Why != nil {
			continue
		}
		if why := confirmedProblem(r); why != "" {
			add(Gap{Type: "unconfirmed-requirement", Subject: k, Files: []string{c.R.Rel(r.File)}, Severity: "warn", Text: fmt.Sprintf("adopted requirement %q %s", r.Name, why), Hint: "add `Confirmed: test <file>: <name>`, `Confirmed: doc <file>` or `Confirmed: owner <name>, <date>`; if nothing confirms it, move it to observed/<capability>.md and remove the requirement (/spec-fix)"})
		}
	}
	observed := c.ObservedEntries()
	obsCaps := map[string]bool{}
	for _, e := range observed {
		obsCaps[e.Cap] = true
		if why := observedProblem(e); why != "" {
			add(Gap{Type: "observed-incomplete", Subject: e.Cap + "/" + e.Slug, Files: []string{c.R.Rel(e.File)}, Line: e.Line, Severity: "warn", Text: fmt.Sprintf("%s:%d: entry %q %s", c.R.Rel(e.File), e.Line, e.Slug, why), Hint: "every entry says what was observed, why it is unconfirmed, who can decide (Owner) and how to confirm it"})
		}
	}
	order, exp := c.ArchivedExpectation(pendingDir)
	for _, k := range order {
		if !reqs.Has(k) {
			add(Gap{Type: "unsynced-archive", Subject: k, Text: fmt.Sprintf("change %s was archived with requirement %s that is not in the living specs (archived without sync, or removed later by hand)", exp[k], k), Hint: "re-add the requirement, or retire it with a REMOVED delta in a change (/spec-garden)"})
		}
	}
	lv := LevelsOf(c.Cfg)
	var notes []string
	if !light && lv.Placement != "off" {
		seenP := map[string]int{}
		for _, x := range c.PlacementProblems(nil, nil) {
			base := x.Kind + "@" + x.File + "#" + x.Keys[0]
			seenP[base]++
			subj := base
			if n := seenP[base]; n > 1 {
				subj = fmt.Sprintf("%s~%d", base, n)
			}
			sev := "warn"
			if lv.Placement == "error" {
				sev = "error"
			}
			hint := "move the marker into the doc comment of the whole function, or on its own line directly above the lines that implement the requirement"
			if x.Kind == "duplicate-marker" {
				hint = "remove the duplicate"
			}
			add(Gap{Type: "misplaced-marker", Subject: subj, Files: []string{x.File}, Severity: sev, Text: fmt.Sprintf("%s:%d: %s: %s", x.File, x.Line, x.Kind, x.Text), Hint: hint})
		}
	}
	if !light {
		fit, level := c.FitProblems(nil, nil)
		for _, x := range fit {
			sev := "warn"
			switch {
			case x.Info:
				sev = "info"
			case level == "error":
				sev = "error"
			}
			hint := "move the marker to the code that decides the requirement"
			if x.Remove {
				hint = "remove the marker (`wingman-spec anchors prune`)"
			}
			add(Gap{Type: "over-anchored", Subject: fmt.Sprintf("%s@%s:%d", x.Key, x.File, x.Line), Files: []string{x.File}, Line: x.Line, Severity: sev, Fit: x.Kind, Removable: x.Remove, Text: x.Text, Hint: hint})
		}
	}
	if !light && lv.Stale != "off" {
		sreqs := map[string]anchors.StaleReq{}
		for _, k := range reqs.keys {
			r := reqs.m[k]
			sreqs[k] = anchors.StaleReq{Cap: r.Cap, File: r.File, Line: r.Line}
		}
		stale, n := anchors.Stale(anchors.StaleOpts{SpecsRoot: c.R.Specs, CodeRoot: c.R.Code, Reqs: sreqs, Markers: facts.Markers, SpecPath: c.specPathOf})
		notes = append(notes, n...)
		sev := lv.Stale
		for _, x := range stale {
			hdr := ""
			if x.Header != "" {
				hdr = " (`" + cut(x.Header, 70) + "`)"
			}
			add(Gap{Type: "stale-anchor", Subject: x.Key + "@" + x.File, Files: []string{x.File}, Commit: x.Commit[:12], Severity: sev,
				Text: fmt.Sprintf("%s:%d: the code anchored to `%s`%s last changed in %s %q, after the requirement text last changed in %s %q", x.File, x.Line, x.Key, hdr, x.Commit[:8], x.Subject, x.SpecCommit[:8], x.SpecSj),
				Hint: fmt.Sprintf("read the diff (git show %s -- %s); if the requirement still holds, `wingman-spec drift decide stale-anchor:%s@%s --accept --note \"...\"` (an `Accepted:` line on the requirement; commit it; a later code change reopens the gap); otherwise update the requirement or the code", x.Commit[:8], x.File, x.Key, x.File)})
		}
	}
	rep := DriftReport{Gaps: []Gap{}, Open: []Gap{}, Accepted: []Gap{}, Counts: map[string]int{}, Requirements: reqs.Len(), Facts: facts, Reqs: reqs, Notes: notes,
		Observed: map[string]int{"entries": len(observed), "files": len(obsCaps)}}
	if rep.Notes == nil {
		rep.Notes = []string{}
	}
	for _, g := range gaps {
		rep.Counts[g.Type]++
		var r *Requirement
		if slices.Contains(Acceptable, g.Type) {
			r, _ = reqs.Get(gapRequirement(g))
		}
		if r != nil && r.Accepted != nil && g.Type != "stale-anchor" {
			g.Accepted = *r.Accepted
			rep.Accepted = append(rep.Accepted, g)
		} else {
			rep.Open = append(rep.Open, g)
		}
		rep.Gaps = append(rep.Gaps, g)
	}
	return rep
}

// specPathOf reports a code-repo path that is a spec file of capability cap (living, delta or archived).
func (c Ctx) specPathOf(p, cap string) bool {
	top, err := filepath.Rel(c.R.Code, c.R.Specs)
	if err != nil {
		return false
	}
	pre := ""
	if top != "." {
		pre = filepath.ToSlash(top) + "/"
	}
	if !strings.HasPrefix(p, pre) {
		return false
	}
	rest := strings.TrimPrefix(p, pre)
	if rest == "specs/"+cap+".md" {
		return true
	}
	parts := strings.Split(rest, "/")
	return (len(parts) == 4 && (parts[0] == "changes" || parts[0] == "archive") && parts[2] == "specs" && parts[3] == cap+".md")
}

var scenarioOrHeading = regexp.MustCompile(`^####\s+Scenario:|^#{2,3}\s`)

// SetAccepted returns text with the requirement's `Accepted:` line set to reason (inserted after the requirement's last line
// before its first scenario, or replaced). Nothing else changes, line endings included.
func SetAccepted(text string, reqLine int, reason string) string {
	lines := strings.Split(text, "\n")
	start := reqLine - 1
	stop := len(lines)
	var fence byte
	at := -1
	for i := start + 1; i < len(lines); i++ {
		if m := fenceRE.FindStringSubmatch(lines[i]); m != nil {
			if fence == 0 {
				fence = m[1][0]
			} else if m[1][0] == fence && m[2] == "" {
				fence = 0
			}
			continue
		}
		if fence != 0 {
			continue
		}
		if scenarioOrHeading.MatchString(lines[i]) {
			stop = i
			break
		}
		if at < 0 && acceptedRE.MatchString(strings.TrimSuffix(lines[i], "\r")) {
			at = i
		}
	}
	cr := func(i int) string {
		if strings.HasSuffix(lines[i], "\r") {
			return "\r"
		}
		return ""
	}
	if at >= 0 {
		next := "Accepted: " + reason + cr(at)
		if lines[at] == next {
			return text
		}
		lines[at] = next
		return strings.Join(lines, "\n")
	}
	last := stop - 1
	for last > start && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	lines = slices.Insert(lines, last+1, "Accepted: "+reason+cr(last))
	return strings.Join(lines, "\n")
}

// AcceptResult is one accepted gap.
type AcceptResult struct {
	Key         string `json:"key"`
	Requirement string `json:"requirement"`
	File        string `json:"file"`
	Line        int    `json:"line"`
	Changed     bool   `json:"changed"`
}

// Accept writes `Accepted: <note>` on each gap's requirement in its living spec (one write per file, idempotent).
func (c Ctx) Accept(gaps []Gap, note string) ([]AcceptResult, error) {
	reason := strings.Join(strings.Fields(note), " ")
	if reason == "" {
		return nil, errors.New("a note (--note) is required: say why, in one line")
	}
	reqs := Living(c.Specs())
	type item struct {
		g Gap
		r *Requirement
	}
	byFile := map[string][]item{}
	var files []string
	for _, g := range gaps {
		if !slices.Contains(Acceptable, g.Type) {
			why := "fix it (see its hint)"
			switch g.Type {
			case "orphan-anchor", "stale-test-tag", "misplaced-marker":
				why = "fix or remove the marker or tag in the code"
			case "unsynced-archive":
				why = "re-add the requirement or retire it with a REMOVED delta in a change"
			}
			return nil, fmt.Errorf("%s: a %s gap cannot be accepted: %s", g.Key, g.Type, why)
		}
		r, ok := reqs.Get(gapRequirement(g))
		if !ok {
			return nil, fmt.Errorf("%s: requirement %s not found in the living specs", g.Key, gapRequirement(g))
		}
		if _, ok := byFile[r.File]; !ok {
			files = append(files, r.File)
		}
		byFile[r.File] = append(byFile[r.File], item{g, r})
	}
	var out []AcceptResult
	for _, f := range files {
		items := byFile[f]
		orig := readIf(f)
		text := orig
		seen := map[string]bool{}
		slices.SortStableFunc(items, func(a, b item) int { return b.r.Line - a.r.Line })
		for _, it := range items {
			res := AcceptResult{Key: it.g.Key, Requirement: it.r.Key, File: c.R.Rel(f), Line: it.r.Line}
			if !seen[it.r.Key] {
				seen[it.r.Key] = true
				next := SetAccepted(text, it.r.Line, reason)
				res.Changed = next != text
				text = next
			}
			out = append(out, res)
		}
		if text != orig {
			if err := os.WriteFile(f, []byte(text), 0o644); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}
