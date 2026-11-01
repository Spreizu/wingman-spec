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
