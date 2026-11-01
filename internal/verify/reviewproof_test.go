package verify

import (
	"slices"
	"testing"
)

func TestReviewFixes(t *testing.T) {
	got := reviewFixes("# Progress\nReviewed anchors: a/b - still holds\n- Review fix: upper-limit - hi - 1 above the limit\nReview fix: tz - untestable: needs a machine in UTC+14\n* Review fix: Bad Slug - ignored\n")
	want := []reviewFix{{"upper-limit", ""}, {"tz", "needs a machine in UTC+14"}}
	if !slices.Equal(got, want) {
		t.Errorf("reviewFixes = %+v, want %+v", got, want)
	}
}

func TestNameFilter(t *testing.T) {
	if f := nameFilter("node", "a-b"); f != `--test-name-pattern='\[review:a-b\]'` {
		t.Errorf("node: %s", f)
	}
	if f := nameFilter("vitest", "x"); f != `-t '\[review:x\]'` {
		t.Errorf("vitest: %s", f)
	}
	if f := nameFilter("", "x"); f != "" {
		t.Errorf("unknown runner: %q", f)
	}
}
