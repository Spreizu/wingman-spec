package report

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestSARIFAndMarkdownAndJUnit(t *testing.T) {
	fs := []Finding{{Source: "drift", Code: "unanchored-requirement", Severity: "error", Message: "no code", File: "specs/a.md", Line: 3, Col: 1}}
	var buf bytes.Buffer
	if err := WriteSARIF(&buf, "wingman-spec", fs); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m["version"] != "2.1.0" {
		t.Fatalf("version %v", m["version"])
	}
	md := Markdown("Drift", fs, nil)
	if !strings.Contains(md, "unanchored-requirement") || !strings.Contains(md, "specs/a.md:3") {
		t.Fatalf("markdown %q", md)
	}
	buf.Reset()
	if err := JUnit(&buf, "finish", fs); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "<failure") {
		t.Fatalf("junit %s", buf.String())
	}
}
