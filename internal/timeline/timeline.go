// Package timeline records what happened while a change was built: one JSON line per event in
// .wingman-spec/runs/<change>/timeline.jsonl. Each event is one append of one line, so parallel commands never rewrite
// each other's lines. Archive copies the file next to archived.json; the editor extension reads it.
//
// Tamper evidence: each line carries prev, the SHA-256 of the line before it, so an edited, deleted or reordered entry
// breaks the chain (Verify). It detects changes; it cannot stop someone rewriting the whole file. Archive anchors the
// head hash in archived.json, which git then keeps.
//
// Decisions: the change's plan (spec deltas, tasks, design.md, ADRs) is hashed at next, check and finish. When it
// differs from the last snapshot (plan-snapshot.json), one decision event lists what changed, the reason and the owner
// approval when a Why changed or a requirement went.
package timeline

import (
	"bytes"
	"crypto/sha1" //nolint:gosec // a content fingerprint, not security
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	// File is the timeline file name.
	File      = "timeline.jsonl"
	snap      = "plan-snapshot.json"
	maxDetail = 4000 // characters of one detail text: the timeline stays small
)

// IsoLocal is t in local time with its offset, to the second: 2026-10-28T14:03:22+02:00.
func IsoLocal(t time.Time) string { return t.Local().Format("2006-01-02T15:04:05-07:00") }

// Event is one timeline line.
type Event struct {
	At      string         `json:"at"`
	Event   string         `json:"event"`
	Task    string         `json:"task,omitempty"`
	OK      *bool          `json:"ok,omitempty"`
	Seconds *float64       `json:"seconds,omitempty"`
	Summary string         `json:"summary"`
	Session *string        `json:"session,omitempty"`
	Run     string         `json:"run,omitempty"`
	Wave    int            `json:"wave,omitempty"` // parallel wave number within the run, and the task's lane in it (1-based)
	Lane    int            `json:"lane,omitempty"`
	Details map[string]any `json:"details,omitempty"`
	Prev    string         `json:"prev,omitempty"` // SHA-256 of the line before (Genesis for the first): the hash chain
}

func cut(v any) any {
	if s, ok := v.(string); ok {
		if r := []rune(s); len(r) > maxDetail {
			return "…" + string(r[len(r)-maxDetail:])
		}
	}
	return v
}

// Append writes one event (best effort: a timeline that cannot be written never fails a check).
func Append(dir string, ev Event) {
	if ev.At == "" {
		ev.At = IsoLocal(time.Now())
	}
	if ev.Details != nil {
		d := map[string]any{}
		for k, v := range ev.Details {
			switch x := v.(type) {
			case nil:
			case []string:
				if len(x) == 0 {
					continue
				}
				out := make([]any, 0, min(len(x), 40))
				for _, s := range x[:min(len(x), 40)] {
					out = append(out, cut(s))
				}
				d[k] = out
			case *string:
				if x != nil {
					d[k] = cut(*x)
				}
			default:
				d[k] = cut(v)
			}
		}
		ev.Details = d
		if len(d) == 0 {
			ev.Details = nil
		}
	}
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	defer lock(dir)()
	ev.Prev = Genesis
	if l := lastLine(filepath.Join(dir, File)); l != nil {
		ev.Prev = LineHash(l)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(ev) != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, File), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = f.Write(buf.Bytes()) // one write per line: concurrent writers (O_APPEND) never tear a line
	_ = f.Close()
}

func sha(s string) string {
	h := sha1.Sum([]byte(s)) //nolint:gosec // fingerprint
	return hex.EncodeToString(h[:])[:12]
}

func read(f string) (string, bool) {
	b, err := os.ReadFile(f)
	if err != nil {
		return "", false
	}
	return strings.ReplaceAll(string(b), "\r\n", "\n"), true
}

type reqSnap struct {
	Section string `json:"section"`
	Body    string `json:"body"`
	Why     string `json:"why"`
}

// Snapshot is the plan as a comparable fingerprint.
type Snapshot struct {
	Reqs   map[string]reqSnap `json:"reqs"`
	Scens  map[string]string  `json:"scens"`
	Tasks  []string           `json:"tasks"`
	ADRs   map[string]string  `json:"adrs"`
	Design *string            `json:"design"`
	Hash   string             `json:"hash"`
}

var (
	h2RE   = regexp.MustCompile(`^##\s+(.*?)\s*$`)
	reqRE  = regexp.MustCompile(`^###\s+Requirement:\s*(.*?)\s*$`)
	scenRE = regexp.MustCompile(`^####\s+Scenario:\s*(.*?)\s*$`)
	whyRE  = regexp.MustCompile(`(?i)^\s*Why:\s*`)
	taskRE = regexp.MustCompile(`^\s*- \[[ xX]\]\s+(.*\S)`)
	decRE  = regexp.MustCompile(`(?mi)^\s*[-*]?\s*Decision:\s*(.+?)\s*$`)
	apprRE = regexp.MustCompile(`(?mi)^\s*[-*]?\s*Owner approval:\s*(.+?)\s*$`)
	h1RE   = regexp.MustCompile(`(?m)^#\s+(.+)$`)
)

// Take fingerprints the plan of changeDir: requirements (text and Why), scenarios, tasks (without ticks), ADRs, design.md.
func Take(changeDir string) Snapshot {
	s := Snapshot{Reqs: map[string]reqSnap{}, Scens: map[string]string{}, Tasks: []string{}, ADRs: map[string]string{}}
	bodies, scens := map[string]*strings.Builder{}, map[string]*strings.Builder{}
	files, _ := filepath.Glob(filepath.Join(changeDir, "specs", "*.md"))
	slices.Sort(files)
	for _, f := range files {
		text, _ := read(f)
		capName := strings.TrimSuffix(filepath.Base(f), ".md")
		section, req, scen := "", "", ""
		for l := range strings.SplitSeq(text, "\n") {
			if m := h2RE.FindStringSubmatch(l); m != nil {
				section = strings.ToUpper(strings.Fields(m[1] + " ")[0])
				req, scen = "", ""
				continue
			}
			if m := reqRE.FindStringSubmatch(l); m != nil {
				req, scen = capName+"/"+m[1], ""
				s.Reqs[req] = reqSnap{Section: section}
				bodies[req] = &strings.Builder{}
				continue
			}
			if m := scenRE.FindStringSubmatch(l); m != nil && req != "" {
				scen = req + "/" + m[1]
				scens[scen] = &strings.Builder{}
				continue
			}
			switch {
			case req == "":
			case scen != "":
				scens[scen].WriteString(strings.TrimSpace(l) + "\n")
			case whyRE.MatchString(l):
				r := s.Reqs[req]
				r.Why = strings.TrimSpace(whyRE.ReplaceAllString(l, ""))
				s.Reqs[req] = r
			default:
				bodies[req].WriteString(strings.TrimSpace(l) + "\n")
			}
		}
	}
	for k, b := range bodies {
		r := s.Reqs[k]
		r.Body = sha(strings.TrimSpace(b.String()))
		s.Reqs[k] = r
	}
	for k, b := range scens {
		s.Scens[k] = sha(strings.TrimSpace(b.String()))
	}
	tt, _ := read(filepath.Join(changeDir, "tasks.md"))
	for l := range strings.SplitSeq(tt, "\n") {
		if m := taskRE.FindStringSubmatch(l); m != nil {
			s.Tasks = append(s.Tasks, m[1])
		}
	}
	adrs, _ := filepath.Glob(filepath.Join(changeDir, "adrs", "*.md"))
	for _, f := range adrs {
		t, _ := read(f)
		s.ADRs[filepath.Base(f)] = sha(t)
	}
	if d, ok := read(filepath.Join(changeDir, "design.md")); ok {
		h := sha(d)
		s.Design = &h
	}
	b, _ := json.Marshal(s)
	s.Hash = sha(string(b))
	return s
}

func keys[V any](a, b map[string]V) []string {
	set := map[string]bool{}
	for k := range a {
		set[k] = true
	}
	for k := range b {
		set[k] = true
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// Diff lists what changed between two snapshots, as short lines.
func Diff(a, b Snapshot) []string {
	var out []string
	for _, k := range keys(a.Reqs, b.Reqs) {
		x, okx := a.Reqs[k]
		y, oky := b.Reqs[k]
		switch {
		case !okx:
			out = append(out, "requirement added: "+k)
		case !oky:
			out = append(out, "requirement removed: "+k)
		default:
			if y.Section == "REMOVED" && x.Section != "REMOVED" {
				out = append(out, "requirement removed: "+k)
			} else if x.Body != y.Body {
				out = append(out, "requirement changed: "+k)
			}
			if x.Why != y.Why {
				out = append(out, fmt.Sprintf("Why changed: %s: %q -> %q", k, x.Why, y.Why))
			}
		}
	}
	out = diffMap(out, "scenario", a.Scens, b.Scens)
	for _, t := range b.Tasks {
		if !slices.Contains(a.Tasks, t) {
			out = append(out, "task added: "+t)
		}
	}
	for _, t := range a.Tasks {
		if !slices.Contains(b.Tasks, t) {
			out = append(out, "task removed: "+t)
		}
	}
	out = diffMap(out, "ADR", a.ADRs, b.ADRs)
	switch {
	case a.Design == nil && b.Design != nil:
		out = append(out, "design.md added")
	case a.Design != nil && b.Design == nil:
		out = append(out, "design.md removed")
	case a.Design != nil && *a.Design != *b.Design:
		out = append(out, "design.md changed")
	}
	return out
}

// diffMap lists the keys added to, removed from or changed between a and b.
func diffMap(out []string, what string, a, b map[string]string) []string {
	for _, k := range keys(a, b) {
		x, okx := a[k]
		y, oky := b[k]
		switch {
		case !okx:
			out = append(out, what+" added: "+k)
		case !oky:
			out = append(out, what+" removed: "+k)
		case x != y:
			out = append(out, what+" changed: "+k)
		}
	}
	return out
}

func reasonFor(changeDir, given string, changes []string) string {
	if given != "" {
		return given
	}
	last := ""
	for _, f := range []string{"proposal.md", "design.md", "tasks.md"} {
		t, _ := read(filepath.Join(changeDir, f))
		for _, m := range decRE.FindAllStringSubmatch(t, -1) {
			last = m[1]
		}
	}
	if last != "" {
		return last
	}
	for _, c := range changes {
		if f, ok := strings.CutPrefix(c, "ADR added: "); ok {
			t, _ := read(filepath.Join(changeDir, "adrs", f))
			if m := h1RE.FindStringSubmatch(t); m != nil {
				return strings.TrimSpace(m[1])
			}
			return ""
		}
	}
	return ""
}

// Ctx is who saw a plan change.
type Ctx struct {
	Reason, Task, Cmd string
	Session           *string
}

// Decide compares the plan with the last snapshot and appends a decision event when it changed. The first call only
// records the snapshot. Returns the event, or nil.
func Decide(dir, changeDir string, ctx Ctx) *Event {
	now := Take(changeDir)
	f := filepath.Join(dir, snap)
	var before *Snapshot
	if b, err := os.ReadFile(f); err == nil {
		var s Snapshot
		if json.Unmarshal(b, &s) == nil {
			before = &s
		}
	}
	if before != nil && before.Hash == now.Hash {
		return nil
	}
	if os.MkdirAll(dir, 0o755) != nil {
		return nil
	}
	b, _ := json.Marshal(now)
	tmp := fmt.Sprintf("%s.%d", f, os.Getpid())
	if os.WriteFile(tmp, append(b, '\n'), 0o644) != nil || os.Rename(tmp, f) != nil {
		return nil
	}
	if before == nil {
		return nil
	}
	changes := Diff(*before, now)
	if len(changes) == 0 {
		return nil
	}
	reason := reasonFor(changeDir, ctx.Reason, changes)
	var appr any
	if slices.ContainsFunc(changes, func(c string) bool {
		return strings.HasPrefix(c, "Why changed:") || strings.HasPrefix(c, "requirement removed:")
	}) {
		t, _ := read(filepath.Join(changeDir, "proposal.md"))
		appr = "missing"
		if m := apprRE.FindStringSubmatch(t); m != nil {
			appr = m[1]
		}
	}
	sum := changes[0]
	if len(changes) > 1 {
		sum = fmt.Sprintf("%d changes", len(changes))
	}
	sum = "plan changed: " + sum
	rs := reason
	if reason != "" {
		sum += " (" + reason + ")"
	} else {
		rs = "none recorded: pass --reason \"<why>\" or add a `Decision: <why>` line to design.md"
	}
	ok := true
	ev := Event{Event: "decision", Task: ctx.Task, Session: ctx.Session, OK: &ok, Summary: sum,
		Details: map[string]any{"changes": changes, "reason": rs, "owner_approval": appr, "seen_at": ctx.Cmd}}
	Append(dir, ev)
	return &ev
}

// Keep copies the timeline into an archived change folder (best effort).
func Keep(dir, archivedDir string) {
	if b, err := os.ReadFile(filepath.Join(dir, File)); err == nil {
		_ = os.WriteFile(filepath.Join(archivedDir, File), b, 0o644)
	}
}

// Archived is archived.json: when the change was archived and, when known, created.
type Archived struct {
	ArchivedAt      string `json:"archived_at"`
	CreatedAt       string `json:"created_at,omitempty"`
	TimelineHead    string `json:"timeline_head,omitempty"` // the hash of the timeline's last entry when archived
	TimelineEntries int    `json:"timeline_entries,omitempty"`
}

// WriteArchived writes archived.json into the archived folder.
func WriteArchived(dir string, now time.Time, created string) (Archived, error) {
	rec := Archived{ArchivedAt: IsoLocal(now), CreatedAt: created}
	b, _ := json.MarshalIndent(rec, "", "  ")
	return rec, os.WriteFile(filepath.Join(dir, "archived.json"), append(b, '\n'), 0o644)
}
