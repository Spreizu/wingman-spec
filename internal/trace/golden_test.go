package trace_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/quality"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

// The editor reads specs, markers, approval lines and ADRs itself to draw its views. This golden file is what the CLI
// reads from the same texts; vscode-extension/test/golden.test.ts compares. WINGMAN_UPDATE_GOLDEN=1 rewrites it.
var specInputs = []struct{ Name, Text string }{
	{"why", "## ADDED\n\n### Requirement: A\nThe A SHALL x.\n\n- **Why**: The **owner** wants x, because y.\n\n#### Scenario: One\nWhy: ignored\n"},
	{"living", "## Purpose\nWhat it is for.\n\n## Requirements\n\n### Requirement: B\nB MUST y.\n\n#### Scenario: S\n\n## Notes\n\n### Requirement: C\nC SHALL z\n#### Scenario: T\n"},
	{"removed and renamed", "## REMOVED\n\n### Requirement: Gone\n**Reason**: x\n\n## RENAMED\n\n- Old -> New\n"},
	{"modified", "## MODIFIED\n\n### Requirement: M\nM SHALL z.\n\n#### Scenario: One\n#### Scenario: Two\n"},
	{"fenced headings", "## ADDED\n\n### Requirement: F\nF SHALL a.\n\n```md\n### Requirement: Not one\n#### Scenario: Not one\n```\n\n#### Scenario: Real\n"},
}

var markerInputs = []struct{ File, Text string }{
	{"src/a.ts", "// @spec cap-a/one\nexport const a = 1;\n"},
	{"src/b.py", "# @spec cap-a/one, cap-b/two-x\nx = 1\n"},
	{"src/c.go", "/* @spec cap-a/three */\npackage c\n// not a marker: @spec nothing\n"},
	{"src/d.sql", "-- @spec cap-d/four\nselect 1;\n"},
	{"src/e.rb", "x = 1 # @spec cap-e/five\n"},
}

var approvalInputs = []string{
	"## Why\nx\nOwner approval: Maria, 2026-10-01\n", "Owner approval:\n", "```\nOwner approval: Fenced, 2026-10-01\n```\n",
	"<!-- Owner approval: Hidden, 2026-10-01 -->\n", "- **Owner approval**: Jo, 2026-10-02\r\n", "nothing here\n",
}

const realADR = "---\ntitle: T\nstatus: Accepted\ndate: 2026-10-20\n---\n\nbody\n"

var adrInputs = []struct{ File, Text string }{
	{"none.md", ""}, {"None.md", realADR}, {"x.md", "---\nstatus: none\n---\n"}, {"x.md", "---\nstatus: None\n---\n"},
	{"x.md", "---\nstatus: \"none\"\n---\n"}, {"x.md", realADR}, {"x.md", realADR + "status: none\n"}, {"x.md", "status: none\n"},
	{"none.md", "---\nstatus: Accepted\n---\n"}, {"x.md", "---\nstatus: nonexistent\n---\n"},
}

type goldenReq struct {
	Name      string   `json:"name"`
	Op        string   `json:"op"`
	Why       *string  `json:"why"`
	Scenarios []string `json:"scenarios"`
}

type grammar struct {
	Specs []struct {
		Name    string      `json:"name"`
		Text    string      `json:"text"`
		Reqs    []goldenReq `json:"reqs"`
		Renames [][2]string `json:"renames"`
	} `json:"specs"`
	Markers []struct {
		File    string           `json:"file"`
		Text    string           `json:"text"`
		Markers []anchors.Marker `json:"markers"`
	} `json:"markers"`
	Approvals []struct {
		Text     string `json:"text"`
		Approval string `json:"approval"`
	} `json:"approvals"`
	ADRs []struct {
		File string `json:"file"`
		Text string `json:"text"`
		None bool   `json:"none"`
	} `json:"adrs"`
}

func TestGrammarGoldenForEditor(t *testing.T) {
	var g grammar
	for _, in := range specInputs {
		p := trace.ParseSpec(in.Text)
		reqs := []goldenReq{}
		for _, r := range p.Reqs {
			sc := []string{}
			for _, s := range r.Scenarios {
				sc = append(sc, s.Name)
			}
			reqs = append(reqs, goldenReq{r.Name, r.Op, r.Why, sc})
		}
		ren := [][2]string{}
		for _, r := range p.Renames {
			ren = append(ren, [2]string{r.From, r.To})
		}
		g.Specs = append(g.Specs, struct {
			Name    string      `json:"name"`
			Text    string      `json:"text"`
			Reqs    []goldenReq `json:"reqs"`
			Renames [][2]string `json:"renames"`
		}{in.Name, in.Text, reqs, ren})
	}
	for _, in := range markerInputs {
		m := anchors.MarkersIn(in.Text)
		if m == nil {
			m = []anchors.Marker{}
		}
		g.Markers = append(g.Markers, struct {
			File    string           `json:"file"`
			Text    string           `json:"text"`
			Markers []anchors.Marker `json:"markers"`
		}{in.File, in.Text, m})
	}
	for _, in := range approvalInputs {
		g.Approvals = append(g.Approvals, struct {
			Text     string `json:"text"`
			Approval string `json:"approval"`
		}{in, trace.ProposalApproval(in)})
	}
	for _, in := range adrInputs {
		g.ADRs = append(g.ADRs, struct {
			File string `json:"file"`
			Text string `json:"text"`
			None bool   `json:"none"`
		}{in.File, in.Text, quality.IsNoneADR(in.File, in.Text)})
	}
	got, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	file := filepath.Join("..", "..", "vscode-extension", "test", "golden", "grammar.json")
	if os.Getenv("WINGMAN_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%v (WINGMAN_UPDATE_GOLDEN=1 go test ./internal/trace/ writes it)", err)
	}
	if string(want) != string(got) {
		t.Fatalf("%s is stale: WINGMAN_UPDATE_GOLDEN=1 go test ./internal/trace/ rewrites it, then check the editor still agrees", file)
	}
}
