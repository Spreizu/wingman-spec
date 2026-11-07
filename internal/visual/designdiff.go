package visual

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/layout"
)

// DiffRow represents one row from the "## Diff vs current code" table in design-map.md.
type DiffRow struct {
	Line     int
	Element  string
	Selector string
	Property string
	Figma    string
	CodeNow  string
	Status   string
	Change   string
}

var (
	diffSectionRE = regexp.MustCompile(`(?im)^##\s+Diff\s+vs\s+current\s+code\s*$`)
	diffRowRE     = regexp.MustCompile(`^\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*)\s*\|\s*$`)
)

// ParseDesignDiff extracts the "## Diff vs current code" table from design-map.md.
func ParseDesignDiff(changeDir string) []DiffRow {
	mapFile := filepath.Join(changeDir, "design-map.md")
	content, ok := layout.ReadString(mapFile)
	if !ok {
		return nil
	}

	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var rows []DiffRow
	inSection := false
	inTable := false

	for i, line := range lines {
		// Check if we're entering the Diff section
		if diffSectionRE.MatchString(line) {
			inSection = true
			continue
		}

		// Exit section when we hit another ## heading
		if inSection && strings.HasPrefix(strings.TrimSpace(line), "##") {
			break
		}

		if !inSection {
			continue
		}

		// Skip the header row and separator row
		if strings.Contains(line, "Element") && strings.Contains(line, "Selector") {
			inTable = true
			continue
		}
		if inTable && strings.HasPrefix(strings.TrimSpace(line), "|---") {
			continue
		}

		// Parse data rows
		if inTable {
			m := diffRowRE.FindStringSubmatch(line)
			if m == nil {
				// Empty line or non-table content ends the table
				if strings.TrimSpace(line) == "" || !strings.HasPrefix(strings.TrimSpace(line), "|") {
					break
				}
				continue
			}

			rows = append(rows, DiffRow{
				Line:     i + 1,
				Element:  strings.TrimSpace(m[1]),
				Selector: strings.TrimSpace(m[2]),
				Property: strings.TrimSpace(m[3]),
				Figma:    strings.TrimSpace(m[4]),
				CodeNow:  strings.TrimSpace(m[5]),
				Status:   strings.TrimSpace(m[6]),
				Change:   strings.TrimSpace(m[7]),
			})
		}
	}

	return rows
}

// DiffCoverageLint checks that every "changed" row in the design diff is covered by at least one task.
// It returns findings for changed rows that no task mentions.
func DiffCoverageLint(changeDir, specsRoot string) []Problem {
	rows := ParseDesignDiff(changeDir)
	if len(rows) == 0 {
		return nil
	}

	// Find all changed rows
	var changedRows []DiffRow
	for _, r := range rows {
		if strings.ToLower(r.Status) == "changed" {
			changedRows = append(changedRows, r)
		}
	}

	if len(changedRows) == 0 {
		return nil
	}

	// Read tasks.md to check coverage
	tasksFile := filepath.Join(changeDir, "tasks.md")
	tasksContent, ok := layout.ReadString(tasksFile)
	if !ok {
		// No tasks.md yet - all changed rows are uncovered
		var out []Problem
		for _, r := range changedRows {
			out = append(out, Problem{
				"file":     "design-map.md",
				"line":     r.Line,
				"kind":     "design-diff-coverage",
				"severity": "error",
				"text":     fmt.Sprintf("design-map.md:%d: changed row (%s %s: %s) is not covered by any task. Every changed design element must have a task that implements it. Group related changes per component when needed to respect task caps.", r.Line, r.Element, r.Property, r.Change),
			})
		}
		return out
	}

	tasksLower := strings.ToLower(tasksContent)

	// Check each changed row for coverage
	var out []Problem
	for _, r := range changedRows {
		covered := false

		// Check if the selector is mentioned (normalize backticks and quotes)
		selector := strings.Trim(r.Selector, "`\"'")
		if strings.Contains(tasksLower, strings.ToLower(selector)) {
			covered = true
		}

		// Check if the element name is mentioned
		if !covered && strings.Contains(tasksLower, strings.ToLower(r.Element)) {
			covered = true
		}

		// Check if the property and change are mentioned together
		if !covered && r.Change != "" {
			// Extract class names from the Change field (e.g., "`text-fg` to `text-primary`")
			changeClasses := extractClasses(r.Change)
			for _, cls := range changeClasses {
				if cls != "" && strings.Contains(tasksLower, cls) {
					covered = true
					break
				}
			}
		}

		if !covered {
			out = append(out, Problem{
				"file":     "design-map.md",
				"line":     r.Line,
				"kind":     "design-diff-coverage",
				"severity": "error",
				"text":     fmt.Sprintf("design-map.md:%d: changed row (%s %s: %s) is not covered by any task. Every changed design element must have a task that implements it. Group related changes per component when needed to respect task caps.", r.Line, r.Element, r.Property, r.Change),
			})
		}
	}

	return out
}

// extractClasses pulls out class names from a Change field like "`text-fg` to `text-primary`" or "token gap-4"
func extractClasses(change string) []string {
	var classes []string
	
	// Extract content within backticks
	backtickRE := regexp.MustCompile("`([^`]+)`")
	matches := backtickRE.FindAllStringSubmatch(change, -1)
	for _, m := range matches {
		if len(m) > 1 {
			classes = append(classes, strings.TrimSpace(m[1]))
		}
	}

	// Also split by common delimiters
	for _, part := range strings.FieldsFunc(change, func(r rune) bool {
		return r == ' ' || r == ',' || r == ';'
	}) {
		part = strings.Trim(part, "`\"'()")
		if part != "" && part != "to" && part != "token" && !strings.HasPrefix(part, "token:") {
			classes = append(classes, part)
		}
	}

	return classes
}

// HasDesignDiff reports whether the change has a design diff table.
func HasDesignDiff(changeDir string) bool {
	mapFile := filepath.Join(changeDir, "design-map.md")
	content, ok := layout.ReadString(mapFile)
	if !ok {
		return false
	}
	return diffSectionRE.MatchString(content)
}
