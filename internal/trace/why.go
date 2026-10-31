package trace

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// WhyMinWords is the shortest Why that can say who wants a requirement and why.
const WhyMinWords = 5

var (
	approvalRE     = regexp.MustCompile(`(?i)^(?:[-*]\s*)?\**Owner approval\**:\s*(.*)$`)
	inlineComment  = regexp.MustCompile(`<!--.*?-->`)
	fenceToggleRE  = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	specOnlyKindRE = regexp.MustCompile(`(?mi)^\s*(?:[-*]\s+)?\**Kind\**:\s*\**spec-only\b`)
)

// ProposalApproval is the owner's approval line of a proposal (`Owner approval: <name>, <date>`), or "".
func ProposalApproval(text string) string {
	fence := false
	out := ""
	for l := range strings.SplitSeq(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if fenceToggleRE.MatchString(l) {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		m := approvalRE.FindStringSubmatch(strings.TrimSpace(inlineComment.ReplaceAllString(l, "")))
		if m != nil {
			if v := strings.TrimSpace(strings.ReplaceAll(m[1], "*", "")); v != "" {
				out = v
			}
		}
	}
	return out
}

// IsSpecOnly reports `Kind: spec-only` in proposal.md: the change only writes specs.
func IsSpecOnly(changeDir string) bool {
	return specOnlyKindRE.MatchString(readIf(filepath.Join(changeDir, "proposal.md")))
}

// Approval is a requirement change that needs the owner.
type Approval struct {
	Key    string  `json:"key"`
	Status string  `json:"status"` // changed | removed
	Was    string  `json:"was"`
	Now    *string `json:"now"`
	File   string  `json:"file"`
	Line   int     `json:"line"`
}

// WhyResult is what WhyLint found.
type WhyResult struct {
	Problems  []Problem  `json:"problems"`
	Approvals []Approval `json:"approvals"`
}

// WhyLint checks that every ADDED or MODIFIED requirement says `Why:` and that rewriting a living Why or removing a
// requirement carries the owner's approval in proposal.md.
func (c Ctx) WhyLint(changeDir string) WhyResult {
	out := WhyResult{Problems: []Problem{}, Approvals: []Approval{}}
	P := func(sev, kind, text, file string, line int) {
		if file == "" {
			file = "proposal.md"
		}
		out.Problems = append(out.Problems, Problem{sev, kind, text, file, line})
	}
	deltas := Deltas(changeDir)
	if len(deltas) == 0 {
		return out
	}
	living := Living(c.Specs())
	for _, d := range deltas {
		rel, _ := filepath.Rel(changeDir, d.File)
		rel = filepath.ToSlash(rel)
		seen := map[string]bool{}
		for _, r := range d.Reqs {
			key := d.Cap + "/" + r.Slug
			loc := fmt.Sprintf("%s:%d", rel, r.Line)
			if seen[r.Slug] {
				P("error", "duplicate-requirement-slug", fmt.Sprintf("%s: requirement %q gives the same anchor slug `%s` as another one in this spec; rename one", loc, r.Name, key), rel, r.Line)
			}
			seen[r.Slug] = true
			was, ok := living.Get(key)
			if !ok {
				for _, rn := range d.Renames {
					if rn.ToSlug == r.Slug {
						was, ok = living.Get(d.Cap + "/" + rn.FromSlug)
						break
					}
				}
			}
			if r.Op == "REMOVED" {
				if ok {
					out.Approvals = append(out.Approvals, Approval{Key: key, Status: "removed", Was: was.WhyText(), File: rel, Line: r.Line})
				}
				continue
			}
			if r.Why == nil {
				P("error", "missing-why", fmt.Sprintf("%s: requirement %q has no `Why:` line. Add one line right under its SHALL statement: who wants this and why, e.g. `Why: The account owner wants to reset a forgotten password, so that they are not locked out.`", loc, r.Name), rel, r.Line)
				continue
			}
			if n := len(strings.Fields(*r.Why)); n < WhyMinWords {
				w := *r.Why
				if w == "" {
					w = "empty"
				}
				P("error", "why-too-short", fmt.Sprintf("%s: the Why of %q is too short to say who wants it and why (%d words at least): %s", loc, r.Name, WhyMinWords, w), rel, r.Line)
			}
			if r.Op == "MODIFIED" && ok && was.Why != nil && strings.Join(strings.Fields(*was.Why), " ") != strings.Join(strings.Fields(*r.Why), " ") {
				out.Approvals = append(out.Approvals, Approval{Key: key, Status: "changed", Was: *was.Why, Now: r.Why, File: rel, Line: r.Line})
			}
		}
	}
	if len(out.Approvals) > 0 && ProposalApproval(readIf(filepath.Join(changeDir, "proposal.md"))) == "" {
		var what []string
		for _, a := range out.Approvals {
			verb := "rewrites the Why of"
			if a.Status == "removed" {
				verb = "removes"
			}
			what = append(what, verb+" "+a.Key)
		}
		P("error", "why-owner-approval", "OWNER APPROVAL: this change "+strings.Join(what, ", ")+". Show the owner the old and the new text, and only after they agree add `Owner approval: <name>, <date>` to proposal.md.", "proposal.md", 1)
	}
	return out
}
