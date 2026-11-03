package scaffold

import (
	"os"
	"path/filepath"
	"testing"
)

// goldenCases are the layouts and detections whose generated wingman-spec.yaml is pinned in testdata/<name>.yaml.
var goldenCases = map[string]Options{
	"repo":          {Layout: Repo},
	"repo-detected": {Layout: Repo, Test: "npm test", Typecheck: "npx tsc --noEmit", Lint: "- lint: x #y", Visual: "npm run preview -- --port 4173", URL: "http://127.0.0.1:4173/"},
	"repo-no-ui":    {Layout: Repo, Test: "go test ./...", Visual: "off"},
	"link-remote":   {Layout: Link, SpecsPath: "../specs", SpecsRemote: "https://example.com/acme/specs.git", Test: "pytest"},
	"link":          {Layout: Link, SpecsPath: "../specs"},
	"specs":         {Layout: Specs},
}

// The generated config is pinned byte for byte: a change to it shows up as a diff of testdata/.
func TestConfigGolden(t *testing.T) {
	for name, o := range goldenCases {
		got, err := Config(o)
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile(filepath.Join("testdata", name+".yaml"))
		if err != nil {
			t.Fatal(err)
		}
		if got != string(want) {
			t.Errorf("%s: Config =\n%s\nwant\n%s", name, got, want)
		}
	}
}
