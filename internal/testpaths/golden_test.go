package testpaths

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The editor extension re-implements IsTestPath, IsTestFile and IsUIFile (core/testpaths.ts); its tests compare
// against this golden file. WINGMAN_UPDATE_GOLDEN=1 rewrites it.
var goldenPaths = []string{
	"src/app.ts", "src/app.test.ts", "src/app.spec.tsx", "tests/billing.py", "test/x.test.js", "__tests__/a.js",
	"pkg/bill/bill_test.go", "pkg/bill/bill.go", "spec/models/user_spec.rb", "app/models/user.rb",
	"src/test/java/com/acme/BillTest.java", "src/main/java/com/acme/Bill.java", "Tests/BillTests.cs", "lib/bill.ex", "test/bill_test.exs",
	"src/components/Grid.vue", "src/components/Grid.svelte", "src/pages/index.astro", "styles/app.css", "README.md",
	"e2e/login.spec.ts", "cypress/e2e/login.cy.ts", "src/__snapshots__/a.snap", "test_utils.py", "tests/fixtures/data.json",
}

type goldenPath struct {
	Path       string `json:"path"`
	IsTestPath bool   `json:"is_test_path"`
	IsTestFile bool   `json:"is_test_file"`
	IsUIFile   bool   `json:"is_ui_file"`
}

func TestGoldenForEditor(t *testing.T) {
	var out []goldenPath
	for _, p := range goldenPaths {
		out = append(out, goldenPath{p, IsTestPath(p), IsTestFile(p), IsUIFile(p)})
	}
	got, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	file := filepath.Join("..", "..", "vscode-extension", "test", "golden", "testpaths.json")
	if os.Getenv("WINGMAN_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%v (run with WINGMAN_UPDATE_GOLDEN=1)", err)
	}
	if string(want) != string(got) {
		t.Fatalf("%s is out of date: run WINGMAN_UPDATE_GOLDEN=1 go test ./internal/testpaths/ and check the extension tests", file)
	}
}
