package testpaths

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Every positive and negative path of tests/lib/test-path-table.json is classified as expected.
func TestPathTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "tests", "lib", "test-path-table.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tab struct {
		Test        []string `json:"test"`
		NotTest     []string `json:"notTest"`
		NotTestFile []string `json:"notTestFile"`
	}
	if err := json.Unmarshal(b, &tab); err != nil {
		t.Fatal(err)
	}
	if len(tab.Test) == 0 || len(tab.NotTest) == 0 {
		t.Fatal("empty table")
	}
	for _, f := range tab.Test {
		if !IsTestPath(f) || !IsTestFile(f) {
			t.Errorf("should be a test: %s", f)
		}
	}
	for _, f := range tab.NotTest {
		if IsTestPath(f) || IsTestFile(f) {
			t.Errorf("should not be a test: %s", f)
		}
	}
	for _, f := range tab.NotTestFile {
		if !IsTestPath(f) || IsTestFile(f) {
			t.Errorf("should be a test path but not a tag-carrying file: %s", f)
		}
	}
}
