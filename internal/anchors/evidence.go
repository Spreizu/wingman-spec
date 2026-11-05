package anchors

import (
	"regexp"
	"strings"
)

var (
	failLine    = regexp.MustCompile(`^\s*(?:not ok\b|[✗✖✕×]|FAIL(?:ED)?\b|--- FAIL\b|\[?FAILED\]?\b|\d+\)\s)`)
	passLine    = regexp.MustCompile(`^\s*(?:ok\b|[✓✔]|PASS(?:ED)?\b|--- PASS\b|\[?PASSED\]?\b)`)
	skipLine    = regexp.MustCompile(`(?i)#\s*(?:SKIP|TODO)\b|\bskipped\b|^\s*[○↓-]\s|^\s*--- SKIP\b|\bSKIPPED\b`)
	evidenceTag = regexp.MustCompile(`\[([a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*)\]`)
)

// EvidenceScenario is a scenario to look for in the test output.
type EvidenceScenario struct{ ID, Requirement string }

// ReqEvidence lists a requirement's scenario ids by state.
type ReqEvidence struct {
	Passed   []string `json:"passed"`
	Failed   []string `json:"failed"`
	Skipped  []string `json:"skipped"`
	Unlisted []string `json:"unlisted"`
}

// Evidence is what the test output says about each tagged scenario.
type Evidence struct {
	ByScenario    map[string]string
	ByRequirement map[string]*ReqEvidence
	Order         []string // requirement keys in first-seen order
}

// TestEvidence reads the test runner output: a scenario is passed (a line with its tag looks like a passing test),
// failed (a failing line names it), skipped (only skipped or todo lines name it) or unlisted (the output never names it:
// a quiet reporter).
func TestEvidence(output string, scenarios []EvidenceScenario) Evidence {
	lines := strings.Split(output, "\n")
	type counts struct{ pass, fail, skip int }
	got := map[string]*counts{}
	for _, s := range scenarios {
		got[s.ID] = &counts{}
	}
	for _, l := range lines {
		ms := evidenceTag.FindAllStringSubmatch(l, -1)
		if len(ms) == 0 {
			continue
		}
		kind := 0
		switch {
		case skipLine.MatchString(l):
			kind = 1
		case failLine.MatchString(l):
			kind = 2
		case passLine.MatchString(l):
			kind = 3
		}
		seen := map[string]bool{}
		for _, m := range ms {
			id := m[1]
			if seen[id] || got[id] == nil {
				continue
			}
			seen[id] = true
			switch kind {
			case 1:
				got[id].skip++
			case 2:
				got[id].fail++
			case 3:
				got[id].pass++
			}
		}
	}
	ev := Evidence{ByScenario: map[string]string{}, ByRequirement: map[string]*ReqEvidence{}}
	for _, s := range scenarios {
		c := got[s.ID]
		st := "unlisted"
		switch {
		case c.fail > 0:
			st = "failed"
		case c.skip > 0:
			st = "skipped"
		case c.pass > 0:
			st = "passed"
		}
		ev.ByScenario[s.ID] = st
		r := ev.ByRequirement[s.Requirement]
		if r == nil {
			r = &ReqEvidence{Passed: []string{}, Failed: []string{}, Skipped: []string{}, Unlisted: []string{}}
			ev.ByRequirement[s.Requirement] = r
			ev.Order = append(ev.Order, s.Requirement)
		}
		switch st {
		case "passed":
			r.Passed = append(r.Passed, s.ID)
		case "failed":
			r.Failed = append(r.Failed, s.ID)
		case "skipped":
			r.Skipped = append(r.Skipped, s.ID)
		default:
			r.Unlisted = append(r.Unlisted, s.ID)
		}
	}
	return ev
}
