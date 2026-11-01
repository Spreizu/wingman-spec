package testpaths

import (
	"path"
	"testing"
)

func TestOneTestCommand(t *testing.T) {
	re := `'\[review:a-b\]|[Rr]eview_a_b'`
	f := []string{"pkg/x_test.go"}
	none := func(string) bool { return false }
	marker := func(m string) func(string) bool { return func(g string) bool { ok, _ := path.Match(g, m); return ok } }
	cases := []struct {
		name string
		o    OneTest
		cmd  string
		mode string
	}{
		{"node:test", OneTest{PerFile: "node --test {files}", Test: "node --test"}, "node --test --test-name-pattern=" + re + " 'pkg/x_test.go'", "name:node:test"},
		{"vitest via npm", OneTest{PerFile: "npx vitest run {files}", Test: "npm test", Script: "vitest"}, "npx vitest run -t " + re + " 'pkg/x_test.go'", "name:vitest"},
		{"jest", OneTest{PerFile: "npx jest {files}", Test: "npx jest"}, "npx jest -t " + re + " 'pkg/x_test.go'", "name:jest"},
		{"mocha", OneTest{PerFile: "mocha {files}", Test: "mocha"}, "mocha --grep " + re + " 'pkg/x_test.go'", "name:mocha"},
		{"bun", OneTest{PerFile: "bun test {files}", Test: "bun test"}, "bun test -t " + re + " 'pkg/x_test.go'", "name:bun"},
		{"deno", OneTest{PerFile: "deno test {files}", Test: "deno test -A"}, `deno test --filter '/\[review:a-b\]|[Rr]eview_a_b/' 'pkg/x_test.go'`, "name:deno"},
		{"go", OneTest{PerFile: "go test {dirs}", Test: "go test ./..."}, "go test -run " + re + " './pkg'", "name:go"},
		{"pytest", OneTest{PerFile: "python -m pytest {files}", Test: "python -m pytest -q"}, "python -m pytest -k 'review_a_b' 'pkg/x_test.go'", "name:pytest"},
		{"cargo", OneTest{Test: "cargo test --workspace"}, "cargo test --workspace 'review_a_b'", "name:cargo"},
		{"dotnet", OneTest{Test: "dotnet test"}, "dotnet test --filter 'FullyQualifiedName~review_a_b'", "name:dotnet"},
		{"maven", OneTest{Test: "./mvnw -q test"}, "./mvnw -q test -Dtest='*#*review_a_b*'", "name:maven"},
		{"gradle", OneTest{Test: "./gradlew test"}, "./gradlew test --tests '*review_a_b*'", "name:gradle"},
		{"rspec", OneTest{PerFile: "bundle exec rspec {files}", Test: "bundle exec rspec"}, "bundle exec rspec -e '[review:a-b]' 'pkg/x_test.go'", "name:rspec"},
		{"phpunit", OneTest{Test: "vendor/bin/phpunit"}, "vendor/bin/phpunit --filter " + re, "name:phpunit"},
		{"swift", OneTest{Test: "swift test"}, "swift test --filter " + re, "name:swift"},
		{"exunit", OneTest{Test: "mix test"}, "mix test --only 'review:a-b'", "name:exunit"},
		{"flutter", OneTest{Test: "flutter test"}, "flutter test --name " + re, "name:flutter"},
		{"dart", OneTest{Test: "dart test"}, "dart test --name " + re, "name:dart"},
		{"marker: make test in a Go module", OneTest{Test: "make test", Has: marker("go.mod")}, "go test ./... -run " + re, "name:go"},
		{"marker: Cargo.toml", OneTest{Test: "make check", Has: marker("Cargo.toml")}, "cargo test 'review_a_b'", "name:cargo"},
		{"marker glob: a .csproj", OneTest{Test: "make", Has: func(g string) bool { return g == "*.csproj" }}, "dotnet test --filter 'FullyQualifiedName~review_a_b'", "name:dotnet"},
		{"override", OneTest{Override: "tox -e py -- -k {id} {file}", PerFile: "go test {dirs}", Test: "go test ./..."}, "tox -e py -- -k review_a_b 'pkg/x_test.go'", "override"},
		{"override {name} {tag}", OneTest{Override: "run {name} {tag}"}, "run " + re + " '[review:a-b]'", "override"},
		{"per file, unknown runner", OneTest{PerFile: "./t.sh {files}", Test: "./t.sh", Has: none}, "./t.sh 'pkg/x_test.go'", "file"},
		{"whole suite", OneTest{Test: "make test", Has: none}, "make test", "suite"},
		{"chained command: suite", OneTest{Test: "go vet ./... && go test ./...", Has: none}, "go vet ./... && go test ./...", "suite"},
		{"nothing", OneTest{}, "", ""},
	}
	for _, c := range cases {
		cmd, mode := c.o.Command("a-b", f)
		if cmd != c.cmd || mode != c.mode {
			t.Errorf("%s:\n got  %s (%s)\n want %s (%s)", c.name, cmd, mode, c.cmd, c.mode)
		}
	}
}

func TestTagged(t *testing.T) {
	for text, want := range map[string]bool{
		`test("limit [review:a-b]", ...)`:     true,
		"func TestReview_a_b(t *testing.T) {": true,
		"def test_review_a_b():":              true,
		`@tag review: "a-b"`:                  true,
		"def test_review_a_bc():":             false,
		"fn review_a_b_above_limit() {":       true,
		"[review:a-bc]":                       false,
	} {
		if Tagged(text, "a-b") != want {
			t.Errorf("Tagged(%q) = %v", text, !want)
		}
	}
}
