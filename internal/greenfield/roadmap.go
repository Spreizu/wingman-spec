package greenfield

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

var (
	sizes     = []string{"S", "M", "L"}
	kebabRE   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	acceptRE  = regexp.MustCompile(`(?ms)^##\s+Acceptance criteria\b.*^\s*[-*]\s+\S`)
	trueRE    = regexp.MustCompile(`(?i)^true$`)
	nfrPrefix = NFRCap + "/"
)

// Issue is one roadmap error or warning.
type Issue struct {
	Code  string  `json:"code"`
	Slice *string `json:"slice"`
	Text  string  `json:"text"`
}

// SliceOut is one slice in the roadmap report.
type SliceOut struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Size          string   `json:"size"`
	RequiredSize  string   `json:"required_size"`
	Milestone     string   `json:"milestone"`
	Status        string   `json:"status"`
	FileStatus    string   `json:"file_status"`
	DependsOn     []string `json:"depends_on"`
	Capabilities  []string `json:"capabilities"`
	Requirements  int      `json:"requirements"`
	Skeleton      bool     `json:"skeleton,omitempty"`
	ContractTests []string `json:"contract_tests,omitempty"`
}

// Overlap is a requirement in more than one slice.
type Overlap struct {
	Requirement string   `json:"requirement"`
	Slices      []string `json:"slices"`
}

// TraceItem is one requirement of a slice with its Why.
type TraceItem struct {
	Key string `json:"key"`
	Why string `json:"why"`
}

// Roadmap is the roadmap check.
type Roadmap struct {
	OK       bool           `json:"ok"`
	Slices   []SliceOut     `json:"slices"`
	Order    []string       `json:"order"`
	NextUp   []string       `json:"next_up"`
	Counts   map[string]int `json:"counts"`
	Coverage struct {
		Requirements int       `json:"requirements"`
		Uncovered    []string  `json:"uncovered"`
		Overlaps     []Overlap `json:"overlaps"`
	} `json:"coverage"`
	Trace    map[string][]TraceItem `json:"trace"`
	Errors   []Issue                `json:"errors"`
	Warnings []Issue                `json:"warnings"`
}

func listOrEmpty(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

// Roadmap checks the slices: dependency graph, ordering, size caps, coverage and the next-up slices. Read-only.
// Roadmap checks the slices: dependency graph, ordering, size caps, coverage and the next-up slices. Read-only.
func (p *Project) Roadmap() *Roadmap {
	sl := p.readSlices()
	for _, s := range sl {
		s.Title, s.Size, s.FileStatus = s.Data.Str("title"), strings.ToUpper(s.Data.Str("size")), or(s.Data.Str("status"), "planned")
		s.Milestone, s.Deps, s.Covers, s.Tests = s.Data.Str("milestone"), s.Data.List("depends_on"), s.Data.List("capabilities"), s.Data.List("contract_tests")
		s.Skeleton = trueRE.MatchString(s.Data.Str("skeleton"))
	}
	w := &roadmapWork{
		p: p, rm: &Roadmap{Errors: []Issue{}, Warnings: []Issue{}, Trace: map[string][]TraceItem{}},
		sl: sl, caps: map[string]capability{}, specCaps: map[string]bool{}, byID: map[string]*slice{},
	}
	for _, c := range p.capabilities() {
		w.caps[c.Cap] = c
	}
	w.reqs = p.living()
	for _, k := range w.reqs.Keys() {
		r, _ := w.reqs.Get(k)
		w.specCaps[r.Cap] = true
	}
	for _, s := range sl {
		w.byID[s.ID] = s
	}
	w.checkIDs()
	order, depth, reach := w.order()
	sliceReqs, nreq, uncovered, overlaps := w.coverage()
	w.sizes(sliceReqs)
	w.skeleton(reach)
	w.milestones(order, sliceReqs, depth)
	w.live(order, sliceReqs, nreq, uncovered, overlaps)
	return w.rm
}

type roadmapWork struct {
	p        *Project
	rm       *Roadmap
	sl       []*slice
	caps     map[string]capability
	reqs     *trace.Reqs
	specCaps map[string]bool
	byID     map[string]*slice
}

func (w *roadmapWork) E(code, id, text string) {
	var sp *string
	if id != "" {
		sp = &id
	}
	w.rm.Errors = append(w.rm.Errors, Issue{code, sp, text})
}

func (w *roadmapWork) W(code, id, text string) {
	var sp *string
	if id != "" {
		sp = &id
	}
	w.rm.Warnings = append(w.rm.Warnings, Issue{code, sp, text})
}

func (w *roadmapWork) checkIDs() {
	for _, s := range w.sl {
		if !s.Has {
			w.E("bad-front-matter", s.ID, s.ID+": no front matter (id, title, capabilities, depends_on, size, status, milestone)")
		}
		if !kebabRE.MatchString(s.ID) {
			w.E("bad-id", s.ID, s.ID+": the file name must be a kebab-case id")
		}
		if id := s.Data.Str("id"); id != "" && id != s.ID {
			w.E("id-mismatch", s.ID, fmt.Sprintf("%s: front matter id '%s' differs from the file name", s.ID, id))
		}
		if s.Title == "" {
			w.E("no-title", s.ID, s.ID+": no title")
		}
		if !slices.Contains(sizes, s.Size) {
			w.E("bad-size", s.ID, fmt.Sprintf("%s: size must be S, M or L (got '%s')", s.ID, s.Size))
		}
		if !slices.Contains(statusOrder, s.FileStatus) {
			w.E("bad-status", s.ID, s.ID+": status must be planned, proposed, applying or done")
		}
		if s.Milestone == "" {
			w.E("no-milestone", s.ID, s.ID+": no milestone (e.g. m1)")
		}
		if len(s.Covers) == 0 {
			w.E("no-capabilities", s.ID, s.ID+": capabilities is empty (list capability names or capability/requirement-slug)")
		}
		if !acceptRE.MatchString(s.Body) {
			w.E("no-acceptance", s.ID, s.ID+`: no "## Acceptance criteria" bullets`)
		}
		for _, d := range s.Deps {
			if d == s.ID {
				w.E("self-dependency", s.ID, s.ID+": depends on itself")
			} else if w.byID[d] == nil {
				w.E("unknown-dependency", s.ID, fmt.Sprintf("%s: depends_on unknown slice '%s'", s.ID, d))
			}
		}
	}
}

func (w *roadmapWork) order() ([]string, map[string]int, func(id string, seen map[string]bool) map[string]bool) {
	// order: topological with a stable tie-break (milestone, then id); a cycle is an error
	remaining := map[string][]string{}
	for _, s := range w.sl {
		var d []string
		for _, x := range s.Deps {
			if w.byID[x] != nil && x != s.ID {
				d = append(d, x)
			}
		}
		remaining[s.ID] = d
	}
	key := func(id string) string { return w.byID[id].Milestone + "\x00" + id }
	order := []string{}
	for len(remaining) > 0 {
		var ready []string
		for id, d := range remaining {
			if !slices.ContainsFunc(d, func(x string) bool { _, ok := remaining[x]; return ok }) {
				ready = append(ready, id)
			}
		}
		if len(ready) == 0 {
			var rest []string
			for id := range remaining {
				rest = append(rest, id)
			}
			slices.Sort(rest)
			w.E("cycle", "", "dependency cycle among: "+strings.Join(rest, ", "))
			order = append(order, rest...)
			break
		}
		slices.SortFunc(ready, func(a, b string) int { return natural(key(a), key(b)) })
		order = append(order, ready[0])
		delete(remaining, ready[0])
	}
	depth := map[string]int{}
	for i, id := range order {
		depth[id] = i + 1
	}
	var reach func(id string, seen map[string]bool) map[string]bool
	reach = func(id string, seen map[string]bool) map[string]bool {
		for _, d := range w.byID[id].Deps {
			if w.byID[d] != nil && !seen[d] {
				seen[d] = true
				reach(d, seen)
			}
		}
		return seen
	}
	return order, depth, reach
}

func (w *roadmapWork) coverage() (map[string][]string, int, []string, []Overlap) {
	// coverage
	covered := map[string][]string{}
	var coveredOrder []string
	sliceReqs := map[string][]string{}
	for _, s := range w.sl {
		var mine []string
		for _, e := range s.Covers {
			cp, req, hasReq := strings.Cut(e, "/")
			_, isCap := w.caps[cp]
			if !isCap && !w.specCaps[cp] {
				w.E("unknown-capability", s.ID, fmt.Sprintf("%s: capability '%s' is neither in %s/ nor a living spec", s.ID, cp, w.p.Rel(w.p.G("capabilities"))))
				continue
			}
			var keys []string
			for _, k := range w.reqs.Keys() {
				if strings.HasPrefix(k, cp+"/") {
					keys = append(keys, k)
				}
			}
			if hasReq && req != "" {
				if !w.reqs.Has(e) {
					w.E("unknown-requirement", s.ID, fmt.Sprintf("%s: requirement '%s' does not exist in %s/", s.ID, e, w.p.Rel(w.p.Root.LivingSpecs())))
				} else {
					keys = []string{e}
				}
			} else if len(keys) == 0 {
				w.E("no-spec", s.ID, fmt.Sprintf("%s: capability '%s' has no living spec yet", s.ID, cp))
			}
			for _, k := range keys {
				if !slices.Contains(mine, k) {
					mine = append(mine, k)
					if _, ok := covered[k]; !ok {
						coveredOrder = append(coveredOrder, k)
					}
					covered[k] = append(covered[k], s.ID)
				}
			}
		}
		sliceReqs[s.ID] = mine
	}
	uncovered := []string{}
	nreq := 0
	for _, k := range w.reqs.Keys() {
		if strings.HasPrefix(k, nfrPrefix) {
			continue
		}
		nreq++
		if _, ok := covered[k]; !ok {
			uncovered = append(uncovered, k)
		}
	}
	slices.Sort(uncovered)
	if len(uncovered) > 0 {
		more := ""
		if len(uncovered) > 8 {
			more = ", ..."
		}
		w.E("uncovered-requirement", "", fmt.Sprintf("%d requirement(s) belong to no slice: %s%s", len(uncovered), strings.Join(uncovered[:min(8, len(uncovered))], ", "), more))
	}
	overlaps := []Overlap{}
	for _, k := range coveredOrder {
		if v := covered[k]; len(v) > 1 {
			overlaps = append(overlaps, Overlap{k, v})
		}
	}
	if len(overlaps) > 0 {
		var parts []string
		for _, o := range overlaps[:min(5, len(overlaps))] {
			parts = append(parts, fmt.Sprintf("%s (%s)", o.Requirement, strings.Join(o.Slices, ", ")))
		}
		w.W("overlap", "", fmt.Sprintf("%d requirement(s) are in more than one slice: %s", len(overlaps), strings.Join(parts, "; ")))
	}
	return sliceReqs, nreq, uncovered, overlaps
}

func (w *roadmapWork) sizes(sliceReqs map[string][]string) {
	// size w.caps
	for _, s := range w.sl {
		mine := sliceReqs[s.ID]
		var capsIn, risk []string
		for _, k := range mine {
			c, _, _ := strings.Cut(k, "/")
			if !slices.Contains(capsIn, c) {
				capsIn = append(capsIn, c)
				if cc, ok := w.caps[c]; ok {
					for _, r := range cc.Risk {
						if !slices.Contains(risk, r) {
							risk = append(risk, r)
						}
					}
				}
			}
		}
		need := quality.RequiredSize(quality.Facts{Capabilities: capsIn, Requirements: len(mine), Risk: risk})
		s.Required, s.Requirements = need.Size, len(mine)
		si := slices.Index(sizes, s.Size)
		if si >= 0 && si < slices.Index(sizes, need.Size) {
			why := append([]string{}, need.Reasons["L"]...)
			if need.Size == "M" {
				why = append(why, need.Reasons["M"]...)
			}
			w.E("size-under", s.ID, fmt.Sprintf("%s: declares size %s but needs %s (%s): declare %s or split the slice", s.ID, s.Size, need.Size, strings.Join(why, "; "), need.Size))
		}
		if si >= 0 && len(mine) > sizeReqCap[s.Size] {
			w.E("size-cap", s.ID, fmt.Sprintf("%s: covers %d requirements, more than a size %s slice may (%d): split it", s.ID, len(mine), s.Size, sizeReqCap[s.Size]))
		}
	}
}

func (w *roadmapWork) skeleton(reach func(id string, seen map[string]bool) map[string]bool) {
	// walking skeleton first
	var sk []*slice
	for _, s := range w.sl {
		if s.Skeleton {
			sk = append(sk, s)
		}
	}
	if len(w.sl) > 0 && len(sk) == 0 {
		w.E("no-skeleton", "", "no walking skeleton: mark exactly one slice `skeleton: true` (the thinnest end-to-end path, with no dependencies)")
	}
	if len(sk) > 1 {
		var ids []string
		for _, s := range sk {
			ids = append(ids, s.ID)
		}
		w.E("multiple-skeletons", "", "more than one skeleton slice: "+strings.Join(ids, ", "))
	}
	if len(sk) == 1 {
		k := sk[0]
		if len(k.Deps) > 0 {
			w.E("skeleton-dependency", k.ID, k.ID+": the skeleton must not depend on anything")
		}
		if k.Requirements > skeletonMaxReq {
			w.E("skeleton-thick", k.ID, fmt.Sprintf("%s: the skeleton covers %d requirements (at most %d); a walking skeleton is the thinnest end-to-end path: move the rest to later slices", k.ID, k.Requirements, skeletonMaxReq))
		}
		for _, s := range w.sl {
			if s != k && !reach(s.ID, map[string]bool{})[k.ID] {
				w.E("not-after-skeleton", s.ID, fmt.Sprintf("%s: does not depend (directly or not) on the skeleton %s; add depends_on: [%s]", s.ID, k.ID, k.ID))
			}
		}
	}
}

func (w *roadmapWork) milestones(order []string, sliceReqs map[string][]string, depth map[string]int) {
	// milestones and integrations
	for _, s := range w.sl {
		for _, d := range s.Deps {
			if w.byID[d] != nil && natural(w.byID[d].Milestone, s.Milestone) > 0 {
				w.E("milestone-order", s.ID, fmt.Sprintf("%s (%s) depends on %s (%s), a later milestone", s.ID, s.Milestone, d, w.byID[d].Milestone))
			}
		}
	}
	var firstCaps []string
	firstOf := map[string]string{}
	for _, id := range order {
		for _, k := range sliceReqs[id] {
			c, _, _ := strings.Cut(k, "/")
			if cc, ok := w.caps[c]; ok && cc.Kind == "integration" && firstOf[c] == "" {
				firstOf[c] = id
				firstCaps = append(firstCaps, c)
			}
		}
	}
	for _, c := range firstCaps {
		id := firstOf[c]
		if !slices.Contains(w.byID[id].Tests, c) {
			w.E("contract-test-missing", id, fmt.Sprintf("%s: first slice that touches integration '%s' must list it under contract_tests (a stub, mock or contract test for it is built in this slice)", id, c))
		}
		if r := w.caps[c].Risk; len(r) > 0 && depth[id] > max(2, int(math.Ceil(float64(len(w.sl))/2))) {
			w.W("risky-late", id, fmt.Sprintf("%s: integration '%s' (risk: %s) first appears at position %d of %d; try the risky integrations earlier", id, c, strings.Join(r, ", "), depth[id], len(w.sl)))
		}
	}
	for _, s := range w.sl {
		for _, t := range s.Tests {
			if !slices.ContainsFunc(sliceReqs[s.ID], func(k string) bool { return strings.Split(k, "/")[0] == t }) {
				w.E("contract-test-unknown", s.ID, fmt.Sprintf("%s: contract_tests lists '%s', which this slice does not cover", s.ID, t))
			}
		}
	}
}

func (w *roadmapWork) live(order []string, sliceReqs map[string][]string, nreq int, uncovered []string, overlaps []Overlap) {
	// live status
	for _, s := range w.sl {
		s.Status = w.p.sliceState(s.ID)
		fi, si := slices.Index(statusOrder, s.FileStatus), slices.Index(statusOrder, s.Status)
		if fi >= 0 && s.FileStatus != s.Status && fi < si {
			w.W("status-stale", s.ID, fmt.Sprintf("%s: file says '%s' but the changes say '%s': update the slice file's status line in the slice's own commit", s.ID, s.FileStatus, s.Status))
		}
	}
	done := map[string]bool{}
	for _, s := range w.sl {
		if s.Status == "done" || s.FileStatus == "done" {
			done[s.ID] = true
		}
	}
	w.rm.NextUp = []string{}
	for _, id := range order {
		if !done[id] && !slices.ContainsFunc(w.byID[id].Deps, func(d string) bool { return !done[d] }) {
			w.rm.NextUp = append(w.rm.NextUp, id)
		}
	}
	for _, s := range w.sl {
		items := []TraceItem{}
		for _, k := range sliceReqs[s.ID] {
			why := ""
			if r, ok := w.reqs.Get(k); ok {
				why = r.WhyText()
			}
			items = append(items, TraceItem{k, why})
		}
		w.rm.Trace[s.ID] = items
	}
	w.rm.Counts = map[string]int{}
	for _, st := range statusOrder {
		w.rm.Counts[st] = 0
	}
	for _, s := range w.sl {
		w.rm.Counts[s.Status]++
	}
	w.rm.Slices = []SliceOut{}
	for _, id := range order {
		s := w.byID[id]
		w.rm.Slices = append(w.rm.Slices, SliceOut{id, s.Title, s.Size, s.Required, s.Milestone, s.Status, s.FileStatus, listOrEmpty(s.Deps),
			listOrEmpty(s.Covers), s.Requirements, s.Skeleton, s.Tests})
	}
	w.rm.Order = order
	w.rm.Coverage.Requirements, w.rm.Coverage.Uncovered, w.rm.Coverage.Overlaps = nreq, uncovered, overlaps
	w.rm.OK = len(w.rm.Errors) == 0
}
