package anchors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The editor extension re-implements Placement and Analyze in TypeScript (core/placement.ts, core/anchorDiff.ts) to
// show findings while typing. This golden file is what the Go side returns for a set of inputs; the extension's tests
// compare against it. WINGMAN_UPDATE_GOLDEN=1 rewrites it.
var goldenInputs = []struct {
	Name   string `json:"name"`
	Text   string `json:"text"`
	IsTest bool   `json:"is_test"`
}{
	{"marker above a function", "// @spec billing/add-item\nfunction add(a, b) {\n  return a + b;\n}\n", false},
	{"trailing marker", "function add(a, b) {\n  return a + b; // @spec billing/add-item\n}\n", false},
	{"duplicate marker", "// @spec billing/add-item\n// @spec billing/add-item\nfunction add() {}\n", false},
	{"file-top marker in code", "// @spec billing/add-item\n\nimport x from 'y';\n\nexport const a = 1;\n", false},
	{"file-top marker in a test", "// @spec billing/add-item\n\nimport x from 'y';\n\ntest('a', () => {});\n", true},
	{"detached marker", "function a() {\n  run();\n  // @spec billing/total\n\n}\n", false},
	{"doc comment marker", "/**\n * Adds an item.\n * @spec billing/add-item\n */\nexport function add(item) {\n  items.push(item);\n}\n", false},
	{"python lines", "def total(items):\n    # @spec billing/total\n    s = sum(i.cents for i in items)\n    return s\n", false},
	{"go func", "// Total sums the bill.\n// @spec billing/total\nfunc Total(items []Item) int {\n\tt := 0\n\tfor _, i := range items {\n\t\tt += i.Cents\n\t}\n\treturn t\n}\n", false},
	{"two keys on one marker", "// @spec billing/add-item, billing/total\nconst x = add(1, 2);\n", false},
	{"no marker", "const x = 1;\n", false},
}

type goldenCase struct {
	Name      string             `json:"name"`
	Text      string             `json:"text"`
	IsTest    bool               `json:"is_test"`
	Placement []PlacementFinding `json:"placement"`
	Units     []Unit             `json:"units"`
}

func TestGoldenForEditor(t *testing.T) {
	var cases []goldenCase
	for _, in := range goldenInputs {
		p := Placement(in.Text, in.IsTest)
		if p == nil {
			p = []PlacementFinding{}
		}
		u := Analyze(in.Text)
		if u == nil {
			u = []Unit{}
		}
		cases = append(cases, goldenCase{in.Name, in.Text, in.IsTest, p, u})
	}
	got, err := json.MarshalIndent(cases, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	file := filepath.Join("..", "..", "vscode-extension", "test", "golden", "anchors.json")
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
	if strings.ReplaceAll(string(want), "\r\n", "\n") != string(got) { // a CRLF checkout is the same file
		t.Fatalf("%s is out of date: run WINGMAN_UPDATE_GOLDEN=1 go test ./internal/anchors/ and check the extension tests", file)
	}
}
