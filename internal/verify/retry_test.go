package verify

import "testing"

func failed(name string) []any {
	return []any{O("check", "tasks", "ok", true), O("check", name, "ok", false)}
}

func TestFingerprint(t *testing.T) {
	cases := []struct{ name, a, b string }{
		{"node:test timing and position", "tests failed (exit 1)\n✖ filter keeps done (12.5ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal\n    at /tmp/x1/a.test.mjs:12:7",
			"tests failed (exit 1)\n✖ filter keeps done (3.1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal\n    at /tmp/y2/a.test.mjs:14:3"},
		{"go test", "tests failed\n--- FAIL: TestSum (0.00s)\n    sum_test.go:9: expected 3, got 2", "tests failed\n--- FAIL: TestSum (0.01s)\n    sum_test.go:11: expected 3, got 2"},
		{"pytest", "tests failed\nFAILED tests/test_sum.py::test_add - assert 2 == 3", "tests failed\nFAILED tests/test_sum.py::test_add - assert 2 == 3"},
		{"commit sha", "lint failed\nerror in 3f9a2b1c4d: unused import", "lint failed\nerror in 9e8d7c6b5a: unused import"},
	}
	for _, c := range cases {
		fa, fb := fingerprint(failed("tests"), []string{c.a}), fingerprint(failed("tests"), []string{c.b})
		if fa == "" || fa != fb {
			t.Errorf("%s: %q != %q", c.name, fa, fb)
		}
	}
	if a, b := fingerprint(failed("tests"), []string{"x\nnot ok 1 - adds\n  expected 3, got 2"}), fingerprint(failed("tests"), []string{"x\nnot ok 1 - adds\n  expected 3, got 4"}); a == b {
		t.Errorf("another error line must be another fingerprint: %q", a)
	}
	if a, b := fingerprint(failed("tests"), []string{"x\nnot ok 1 - adds\n  expected 3"}), fingerprint(failed("done_when"), []string{"x\nnot ok 1 - adds\n  expected 3"}); a == b {
		t.Errorf("another check must be another fingerprint: %q", a)
	}
	if fp := fingerprint([]any{O("check", "tasks", "ok", true)}, []string{"subagent reported STATUS: failed"}); fp != "" {
		t.Errorf("no failed check: want no fingerprint, got %q", fp)
	}
	if fp := fingerprint(failed("tests"), []string{"tests failed\nnot ok 3 - sum adds # 19.59ms\n  AssertionError: expected 3, got 2"}); fp != "tests | sum adds | AssertionError: expected 3, got 2" {
		t.Errorf("fingerprint shape: %q", fp)
	}
}
