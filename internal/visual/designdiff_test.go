package visual

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestParseDesignDiff(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    int // number of rows expected
	}{
		{
			name: "empty file",
			content: `# Design map: test
## Map
| Region | Selector | Implemented with | Source | Expect |
|---|---|---|---|---|
| Header | [data-testid="header"] | flex gap-4 | token | gap ~ token:spacing |
`,
			want: 0,
		},
		{
			name: "with diff section",
			content: `# Design map: test
## Map
| Region | Selector | Implemented with | Source | Expect |
|---|---|---|---|---|
| Header | [data-testid="header"] | flex gap-4 | token | gap ~ token:spacing |

## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | [data-testid="account-name"] | color | #3b5bdb | #1b1f2a | changed | text-fg to text-primary |
| Account name | [data-testid="account-name"] | font-weight | 700 | 600 | changed | font-semibold to font-bold |
| Account text | [data-testid="account-text"] | gap | 8px | 4px | changed | gap-1 to gap-2 |
| Account name | [data-testid="account-name"] | font-size | 28px | 28px | same | not edited |

## Gaps
- None
`,
			want: 4,
		},
		{
			name: "diff with backticks",
			content: `## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Button | ` + "`[data-testid=\"btn\"]`" + ` | padding | 12px | 8px | changed | ` + "`p-2` to `p-3`" + ` |
`,
			want: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			mapFile := filepath.Join(tmpDir, "design-map.md")
			if err := os.WriteFile(mapFile, []byte(tt.content), 0644); err != nil {
				t.Fatal(err)
			}

			rows := ParseDesignDiff(tmpDir)
			if len(rows) != tt.want {
				t.Errorf("ParseDesignDiff() got %d rows, want %d", len(rows), tt.want)
			}
		})
	}
}

func TestDiffCoverageLint(t *testing.T) {
	tests := []struct {
		name         string
		mapContent   string
		tasksContent string
		wantProblems int
		wantKind     string
	}{
		{
			name: "no diff section",
			mapContent: `# Design map: test
## Map
| Region | Selector | Implemented with | Source | Expect |
|---|---|---|---|---|
| Header | [data-testid="header"] | flex gap-4 | token | gap ~ token:spacing |
`,
			tasksContent: `# Tasks
- [ ] Task A: Build header
  - Files: src/Header.tsx
`,
			wantProblems: 0,
		},
		{
			name: "all changed rows covered",
			mapContent: `## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | [data-testid="account-name"] | color | #3b5bdb | #1b1f2a | changed | text-fg to text-primary |
| Account name | [data-testid="account-name"] | font-weight | 700 | 600 | changed | font-semibold to font-bold |
| Account text | [data-testid="account-text"] | gap | 8px | 4px | same | not edited |
`,
			tasksContent: `# Tasks
- [ ] Task A: Update account name styling
  - Files: src/Account.tsx
  - Change [data-testid="account-name"] from text-fg to text-primary
  - Change [data-testid="account-name"] font-semibold to font-bold
`,
			wantProblems: 0,
		},
		{
			name: "changed row not covered",
			mapContent: `## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | [data-testid="account-name"] | color | #3b5bdb | #1b1f2a | changed | text-fg to text-primary |
| Avatar | [data-testid="avatar"] | size | 48px | 32px | changed | w-8 to w-12 |
`,
			tasksContent: `# Tasks
- [ ] Task A: Update account name
  - Files: src/Account.tsx
  - Change account name color to text-primary
`,
			wantProblems: 1,
			wantKind:     "design-diff-coverage",
		},
		{
			name: "multiple uncovered rows",
			mapContent: `## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | [data-testid="account-name"] | color | #3b5bdb | #1b1f2a | changed | text-fg to text-primary |
| Avatar | [data-testid="avatar"] | size | 48px | 32px | changed | w-8 to w-12 |
| Button | [data-testid="save-btn"] | padding | 12px | 8px | changed | p-2 to p-3 |
`,
			tasksContent: `# Tasks
- [ ] Task A: Update account name
  - Files: src/Account.tsx
`,
			wantProblems: 2,
		},
		{
			name: "no tasks file",
			mapContent: `## Diff vs current code
| Element | Selector | Property | Figma | Code now | Status | Change |
|---|---|---|---|---|---|---|
| Account name | [data-testid="account-name"] | color | #3b5bdb | #1b1f2a | changed | text-fg to text-primary |
`,
			tasksContent: "", // Will not create tasks.md
			wantProblems: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpDir := t.TempDir()

			// Write design-map.md
			mapFile := filepath.Join(tmpDir, "design-map.md")
			if err := os.WriteFile(mapFile, []byte(tt.mapContent), 0644); err != nil {
				t.Fatal(err)
			}

			// Write tasks.md if content is provided
			if tt.tasksContent != "" {
				tasksFile := filepath.Join(tmpDir, "tasks.md")
				if err := os.WriteFile(tasksFile, []byte(tt.tasksContent), 0644); err != nil {
					t.Fatal(err)
				}
			}

			problems := DiffCoverageLint(tmpDir, tmpDir)

			if len(problems) != tt.wantProblems {
				t.Errorf("DiffCoverageLint() got %d problems, want %d", len(problems), tt.wantProblems)
				for i, p := range problems {
					t.Logf("  problem %d: %v", i, p["text"])
				}
			}

			if tt.wantKind != "" && len(problems) > 0 {
				if kind, ok := problems[0]["kind"].(string); !ok || kind != tt.wantKind {
					t.Errorf("DiffCoverageLint() got kind %q, want %q", kind, tt.wantKind)
				}
			}
		})
	}
}

func TestExtractClasses(t *testing.T) {
	tests := []struct {
		change string
		want   []string
	}{
		{
			change: "`text-fg` to `text-primary`",
			want:   []string{"text-fg", "text-primary"},
		},
		{
			change: "token gap-4",
			want:   []string{"gap-4"},
		},
		{
			change: "`font-semibold` to `font-bold`",
			want:   []string{"font-semibold", "font-bold"},
		},
		{
			change: "p-2 to p-3",
			want:   []string{"p-2", "p-3"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.change, func(t *testing.T) {
			got := extractClasses(tt.change)

			// Check that all wanted classes are present
			for _, w := range tt.want {
				if !slices.Contains(got, w) {
					t.Errorf("extractClasses(%q) missing class %q, got %v", tt.change, w, got)
				}
			}
		})
	}
}

func TestHasDesignDiff(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{
			name: "has diff section",
			content: `# Design map
## Diff vs current code
| Element | Selector | Property |
`,
			want: true,
		},
		{
			name: "no diff section",
			content: `# Design map
## Map
| Region | Selector |
`,
			want: false,
		},
		{
			name: "case insensitive",
			content: `# Design map
## diff vs Current Code
| Element | Selector |
`,
			want: true,
		},
		{
			name:    "no file",
			content: "",
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpDir := t.TempDir()

			// Only write file if content is provided
			if tt.content != "" {
				mapFile := filepath.Join(tmpDir, "design-map.md")
				if err := os.WriteFile(mapFile, []byte(tt.content), 0644); err != nil {
					t.Fatal(err)
				}
			}

			got := HasDesignDiff(tmpDir)
			if got != tt.want {
				t.Errorf("HasDesignDiff() = %v, want %v (content starts with: %q)", got, tt.want, tt.content[:min(50, len(tt.content))])
			}
		})
	}
}
