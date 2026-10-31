package anchors

import (
	"regexp"
	"strings"
)

var (
	failLine = regexp.MustCompile(`^\s*(?:not ok\b|[✗✖✕×]|FAIL(?:ED)?\b|--- FAIL\b|\[?FAILED\]?\b|\d+\)\s)`)
	passLine = regexp.MustCompile(`^\s*(?:ok\b|[✓✔]|PASS(?:ED)?\b|--- PASS\b|\[?PASSED\]?\b)`)
	skipLine = regexp.MustCompile(`(?i)#\s*(?:SKIP|TODO)\b|\bskipped\b|^\s*[○↓-]\s|^\s*--- SKIP\b|\bSKIPPED\b`)
)

// EvidenceScenario is a scenario to look for in the test output.
type EvidenceScenario struct{ ID, Requirement string }

// ReqEvidence lists a requirement's scenario ids by state.
type ReqEvidence struct {
	Passed   []string `json:"passed"`
	Failed   []string `json:"failed"`
	Unlisted []string `json:"unlisted"`
}

// Evidence is what the test output says about each tagged scenario.
type Evidence struct {
	ByScenario    map[string]string
	ByRequirement map[string]*ReqEvidence
	Order         []string // requirement keys in first-seen order
}

// TestEvidence reads the test runner output: a scenario is passed (a line with its tag looks like a passing test),
// failed (a failing or skipped line names it) or unlisted (the output never names it: a quiet reporter).
func TestEvidence(output string, scenarios []EvidenceScenario) Evidence {
	lines := strings.Split(output, "\n")
	ev := Evidence{ByScenario: map[string]string{}, ByRequirement: map[string]*ReqEvidence{}}
	for _, s := range scenarios {
		tag := "[" + s.ID + "]"
		pass, fail := 0, 0
		for _, l := range lines {
			if !strings.Contains(l, tag) {
				continue
			}
			if skipLine.MatchString(l) || failLine.MatchString(l) {
				fail++
			} else if passLine.MatchString(l) {
				pass++
			}
		}
		st := "unlisted"
		if fail > 0 {
			st = "failed"
		} else if pass > 0 {
			st = "passed"
		}
		ev.ByScenario[s.ID] = st
		r := ev.ByRequirement[s.Requirement]
		if r == nil {
			r = &ReqEvidence{Passed: []string{}, Failed: []string{}, Unlisted: []string{}}
			ev.ByRequirement[s.Requirement] = r
			ev.Order = append(ev.Order, s.Requirement)
		}
		switch st {
		case "passed":
			r.Passed = append(r.Passed, s.ID)
		case "failed":
			r.Failed = append(r.Failed, s.ID)
		default:
			r.Unlisted = append(r.Unlisted, s.ID)
		}
	}
	return ev
}
