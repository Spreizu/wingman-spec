package verify

import (
	"reflect"
	"testing"
)

func TestFinishChecks(t *testing.T) {
	got := finishChecks([]any{
		O("check", "tests", "ok", true, "seconds", 1.5),
		O("check", "visual", "ok", true, "skipped", "visual: off"),
		O("check", "trace", "ok", true, "untested", []string{"demo/greet"}),
		O("ok", true), // no name: dropped
		"not an object",
	})
	want := []map[string]any{
		{"name": "tests", "ok": true},
		{"name": "visual", "ok": true, "skipped": "visual: off"},
		{"name": "trace", "ok": true, "untested": []string{"demo/greet"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("finishChecks = %v, want %v", got, want)
	}
	if finishChecks(nil) != nil {
		t.Fatal("no checks: nil")
	}
}
