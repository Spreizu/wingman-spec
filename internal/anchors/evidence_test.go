package anchors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real node:test runner output (testdata/evidence, recorded from one file with a passing, a failing, a skipped and an
// untagged test): passed only from a passing line, a failing or skipped line is failed, a quiet reporter claims nothing.
func TestEvidenceFromRunnerOutput(t *testing.T) {
	var sc []EvidenceScenario
	for _, n := range []string{"added", "removed", "skipped", "ghost"} {
		sc = append(sc, EvidenceScenario{ID: "todo/" + n, Requirement: "todo/" + n + "-req"})
	}
	want := map[string]string{
		"tap":  "added=passed removed=failed skipped=failed ghost=unlisted",
		"spec": "added=passed removed=failed skipped=failed ghost=unlisted",
	}
	for _, f := range []string{"tap", "spec", "dot"} {
		b, err := os.ReadFile(filepath.Join("testdata", "evidence", f+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		e := TestEvidence(string(b), sc)
		var got []string
		for _, s := range sc {
			got = append(got, strings.TrimPrefix(s.ID, "todo/")+"="+e.ByScenario[s.ID])
		}
		g := strings.Join(got, " ")
		if w, ok := want[f]; ok && g != w {
			t.Errorf("%s: got %q, want %q", f, g, w)
		}
		if f == "dot" && e.ByScenario["todo/added"] != "unlisted" {
			t.Errorf("dot: a passing test whose name is not printed must stay unlisted, got %q", g)
		}
	}
}
