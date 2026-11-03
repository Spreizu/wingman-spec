// Package report writes CLI findings as SARIF, Markdown or JUnit XML.
package report

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// SchemaVersion is the JSON `schema_version` field on machine output.
const SchemaVersion = 1

// Finding is one located result a report format can render.
type Finding struct {
	Source   string
	Code     string
	Severity string
	Message  string
	File     string
	Line     int
	Col      int
	Key      string
	Hint     string
}

// SARIF is a SARIF 2.1.0 log of findings (GitHub code scanning, VS Code SARIF viewer).
func SARIF(tool string, fs []Finding) map[string]any {
	rules := map[string]bool{}
	var results []map[string]any
	for _, f := range fs {
		id := f.Code
		if id == "" {
			id = f.Source
		}
		if id == "" {
			id = "finding"
		}
		rules[id] = true
		level := "note"
		switch f.Severity {
		case "error":
			level = "error"
		case "warning", "warn":
			level = "warning"
		}
		loc := map[string]any{
			"physicalLocation": map[string]any{
				"artifactLocation": map[string]any{"uri": f.File},
				"region":           map[string]any{"startLine": max(1, f.Line), "startColumn": max(1, f.Col)},
			},
		}
		results = append(results, map[string]any{
			"ruleId": id, "level": level, "message": map[string]any{"text": f.Message},
			"locations": []any{loc},
		})
	}
	var ruleList []any
	for id := range rules {
		ruleList = append(ruleList, map[string]any{"id": id, "name": id})
	}
	if results == nil {
		results = []map[string]any{}
	}
	return map[string]any{
		"$schema": "https://json.schemastore.org/sarif-2.1.0.json",
		"version": "2.1.0",
		"runs": []any{map[string]any{
			"tool": map[string]any{"driver": map[string]any{
				"name": tool, "informationUri": "https://github.com/Spreizu/wingman-spec", "rules": ruleList,
			}},
			"results": results,
		}},
	}
}

// WriteSARIF writes indented SARIF JSON.
func WriteSARIF(w io.Writer, tool string, fs []Finding) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(SARIF(tool, fs))
}

// Markdown is a traceability or findings summary for a PR comment.
func Markdown(title string, fs []Finding, extra []string) string {
	var b strings.Builder
	b.WriteString("## " + title + "\n\n")
	if len(fs) == 0 && len(extra) == 0 {
		b.WriteString("No findings.\n")
		return b.String()
	}
	if len(fs) > 0 {
		b.WriteString("| Severity | Rule | File | Message |\n|---|---|---|---|\n")
		for _, f := range fs {
			loc := f.File
			if f.Line > 0 {
				loc = fmt.Sprintf("%s:%d", f.File, f.Line)
			}
			msg := strings.ReplaceAll(strings.ReplaceAll(f.Message, "|", "/"), "\n", " ")
			fmt.Fprintf(&b, "| %s | `%s` | %s | %s |\n", f.Severity, f.Code, loc, msg)
		}
		b.WriteByte('\n')
	}
	for _, x := range extra {
		b.WriteString(x)
		if !strings.HasSuffix(x, "\n") {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

type junitSuites struct {
	XMLName xml.Name     `xml:"testsuites"`
	Suites  []junitSuite `xml:"testsuite"`
}

type junitSuite struct {
	Name      string      `xml:"name,attr"`
	Tests     int         `xml:"tests,attr"`
	Failures  int         `xml:"failures,attr"`
	TestCases []junitCase `xml:"testcase"`
}

type junitCase struct {
	Name      string        `xml:"name,attr"`
	Classname string        `xml:"classname,attr"`
	Failure   *junitFailure `xml:"failure,omitempty"`
}

type junitFailure struct {
	Message string `xml:"message,attr"`
	Body    string `xml:",chardata"`
}

// JUnit writes a JUnit XML document of findings (a failure per error).
func JUnit(w io.Writer, suite string, fs []Finding) error {
	s := junitSuite{Name: suite, Tests: max(1, len(fs))}
	if len(fs) == 0 {
		s.TestCases = []junitCase{{Name: "ok", Classname: suite}}
	}
	for _, f := range fs {
		c := junitCase{Name: f.Code, Classname: f.File}
		if f.Line > 0 {
			c.Classname = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		if f.Severity == "error" {
			s.Failures++
			c.Failure = &junitFailure{Message: f.Message, Body: f.Hint}
		}
		s.TestCases = append(s.TestCases, c)
	}
	if s.Tests == 0 {
		s.Tests = len(s.TestCases)
	}
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	if _, err := io.WriteString(w, xml.Header); err != nil {
		return err
	}
	return enc.Encode(junitSuites{Suites: []junitSuite{s}})
}
