package detect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetect(t *testing.T) {
	for _, tt := range []struct {
		name  string
		files map[string]string
		want  Result
	}{
		{"vite with pnpm", map[string]string{"package.json": `{"scripts":{"test":"vitest run","lint":"eslint .","build":"vite build","preview":"vite preview"},"devDependencies":{"vite":"5"}}`, "pnpm-lock.yaml": ""},
			Result{Test: "pnpm test", Lint: "pnpm lint", Visual: "pnpm build && pnpm preview -- --port 4173 --strictPort --host 127.0.0.1", URL: "http://127.0.0.1:4173/"}},
		{"npm default test script is not a test", map[string]string{"package.json": `{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"},"dependencies":{"react":"18"}}`}, Result{}},
		{"go", map[string]string{"go.mod": "module x\n", ".golangci.yml": ""}, Result{Test: "go test ./...", Typecheck: "go vet ./...", Lint: "golangci-lint run", Visual: "off"}},
		{"python", map[string]string{"pyproject.toml": "[tool.pytest.ini_options]\n[tool.mypy]\nfiles = src\n[tool.ruff]\n"}, Result{Test: "python3 -m pytest", Typecheck: "python3 -m mypy", Lint: "ruff check .", Visual: "off"}},
	} {
		d := t.TempDir()
		for n, b := range tt.files {
			if err := os.WriteFile(filepath.Join(d, n), []byte(b), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		got := Detect(d, false)
		if got.Test != tt.want.Test || got.Typecheck != tt.want.Typecheck || got.Lint != tt.want.Lint || got.Visual != tt.want.Visual || got.URL != tt.want.URL {
			t.Errorf("%s: %+v", tt.name, got)
		}
	}
}

func TestProbe(t *testing.T) {
	d := t.TempDir()
	if n := Probe(d, "true"); n != "" {
		t.Error(n)
	}
	if n := Probe(d, "exit 3"); n != "detected `exit 3` but it fails on the current code (exit 3)" {
		t.Error(n)
	}
	if n := Probe(d, "no-such-tool-xyz"); n != "detected `no-such-tool-xyz` but it is not installed here" {
		t.Error(n)
	}
}
