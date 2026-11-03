package trace

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/runstate"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// ReqResult is the last recorded test result of one requirement: its scenarios by state, and fingerprints of the
// requirement text and of the code under its @spec markers at the time, which tell a stale result from a current one.
type ReqResult struct {
	Scenarios map[string]string `json:"scenarios"` // scenario id -> passed | failed | skipped
	Spec      string            `json:"spec"`
	Code      string            `json:"code"`
	At        string            `json:"at"`
	Commit    string            `json:"commit,omitempty"`
	Tree      string            `json:"tree,omitempty"`
}

// Results is the test-results cache (derived data under .wingman-spec/cache/, never committed).
type Results struct {
	Version      int                   `json:"version"`
	Requirements map[string]*ReqResult `json:"requirements"`
}

// Coverage is the state of one requirement's tests: passed, failed, skipped, not run, or stale (the requirement text or the
// code under its markers changed since the result was recorded; Last is the recorded state).
type Coverage struct {
	State     string            `json:"state"`
	Reason    string            `json:"reason,omitempty"` // spec changed | code changed
	Last      string            `json:"last,omitempty"`
	At        string            `json:"at,omitempty"`
	Commit    string            `json:"commit,omitempty"`
	Scenarios map[string]string `json:"scenarios,omitempty"`
}

// ResultsPath is where finish records the test results.
func (c Ctx) ResultsPath() string {
	return filepath.Join(c.R.State(), layout.CacheDir, "test-results.json")
}

func (c Ctx) readResults() Results {
	var r Results
	runstate.ReadJSON(c.ResultsPath(), &r)
	if r.Requirements == nil {
		r.Requirements = map[string]*ReqResult{}
	}
	return r
}

func fingerprint(parts []string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(h[:8])
}

func specPrint(r *Requirement) string { return fingerprint([]string{r.Block}) }

// codePrints fingerprints, per requirement key, the code units its non-test markers anchor (normalized text, no file
// names, so a move or a comment edit does not make a result stale).
func (c Ctx) codePrints(keys map[string]bool) map[string]string {
	units := map[string][]string{}
	for _, f := range c.files().Files {
		if f.Text == "" || !strings.Contains(f.Text, "@spec") || testpaths.IsTestPath(f.Rel) {
			continue
		}
		for _, u := range anchors.Analyze(f.Text) {
			if keys[u.Key] {
				units[u.Key] = append(units[u.Key], u.Header+"\n"+u.Body)
			}
		}
	}
	out := map[string]string{}
	for k := range keys {
		slices.Sort(units[k])
		out[k] = fingerprint(units[k])
	}
	return out
}

// RecordResults stores the scenario states the test output shows for the requirements of reqs (passed, failed, skipped;
// a scenario the output does not name is not recorded). A requirement the output names replaces its earlier record; the
// others keep theirs.
func (c Ctx) RecordResults(reqs *Reqs, out string) (int, error) {
	var sc []anchors.EvidenceScenario
	for _, k := range reqs.Keys() {
		r, _ := reqs.Get(k)
		for _, s := range r.Scenarios {
			sc = append(sc, anchors.EvidenceScenario{ID: r.Cap + "/" + s.Slug, Requirement: k})
		}
	}
	ev := anchors.TestEvidence(out, sc)
	seen := map[string]bool{}
	for k, v := range ev.ByRequirement {
		if len(v.Passed)+len(v.Failed)+len(v.Skipped) > 0 {
			seen[k] = true
		}
	}
	if len(seen) == 0 {
		return 0, nil
	}
	res := c.readResults()
	res.Version = 1
	fp := runstate.Fingerprinted(c.R.Code, true)
	at := runstate.Now()
	code := c.codePrints(seen)
	for k := range seen {
		r, _ := reqs.Get(k)
		rec := &ReqResult{Scenarios: map[string]string{}, Spec: specPrint(r), Code: code[k], At: at, Commit: fp.Head, Tree: fp.Tree}
		for _, s := range r.Scenarios {
			if st := ev.ByScenario[r.Cap+"/"+s.Slug]; st != "unlisted" && st != "" {
				rec.Scenarios[r.Cap+"/"+s.Slug] = st
			}
		}
		res.Requirements[k] = rec
	}
	return len(seen), runstate.WriteJSON(c.ResultsPath(), res)
}

// CoverageOf is the test state of every requirement of reqs, from the recorded results and the current specs and code.
func (c Ctx) CoverageOf(reqs *Reqs) map[string]Coverage {
	res := c.readResults()
	out := map[string]Coverage{}
	keys := map[string]bool{}
	for _, k := range reqs.Keys() {
		if res.Requirements[k] != nil {
			keys[k] = true
		}
	}
	code := map[string]string{}
	if len(keys) > 0 {
		code = c.codePrints(keys)
	}
	for _, k := range reqs.Keys() {
		rec := res.Requirements[k]
		if rec == nil {
			out[k] = Coverage{State: "not run"}
			continue
		}
		r, _ := reqs.Get(k)
		st := "passed"
		for _, s := range rec.Scenarios {
			if s == "failed" {
				st = "failed"
				break
			}
			if s == "skipped" {
				st = "skipped"
			}
		}
		cv := Coverage{State: st, At: rec.At, Commit: rec.Commit, Scenarios: rec.Scenarios}
		switch {
		case rec.Spec != specPrint(r):
			cv.State, cv.Reason, cv.Last = "stale", "spec changed", st
		case rec.Code != code[k]:
			cv.State, cv.Reason, cv.Last = "stale", "code changed", st
		}
		out[k] = cv
	}
	return out
}

// CoverageCounts counts the states (a stale one under "stale: <reason>").
func CoverageCounts(cv map[string]Coverage) map[string]int {
	n := map[string]int{}
	for _, x := range cv {
		k := x.State
		if x.Reason != "" {
			k += ": " + x.Reason
		}
		n[k]++
	}
	return n
}
