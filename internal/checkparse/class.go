package checkparse

import "regexp"

// Line is how one runner output line reads.
type Line string

// Line classes.
const (
	LinePass  Line = "pass"
	LineFail  Line = "fail"
	LineSkip  Line = "skip"
	LineOther Line = "other"
)

var (
	failLine = regexp.MustCompile(`^\s*(?:not ok\b|[✗✖✕×]|FAIL(?:ED)?\b|--- FAIL\b|\[?FAILED\]?\b|\d+\)\s)`)
	passLine = regexp.MustCompile(`^\s*(?:ok\b|[✓✔]|PASS(?:ED)?\b|--- PASS\b|\[?PASSED\]?\b)`)
	skipLine = regexp.MustCompile(`(?i)#\s*(?:SKIP|TODO)\b|\bskipped\b|^\s*[○↓-]\s|^\s*--- SKIP\b|\bSKIPPED\b`)
	// failureNameREs is the first failing test: node:test, TAP, vitest/jest, pytest, go, mocha.
	// The first pattern that matches wins, including when a later pattern occurs earlier in the text.
	failureNameREs = []*regexp.Regexp{
		regexp.MustCompile(`(?m)^\s*not ok \d+ - (.+)$`),
		regexp.MustCompile(`(?m)^\s*[✖×✗]\s+(.+?)(\s+\(\d.*\))?$`),
		regexp.MustCompile(`(?m)^\s*FAIL\s+(\S+.*)$`),
		regexp.MustCompile(`(?m)^FAILED (\S+)`),
		regexp.MustCompile(`(?m)^\s*--- FAIL: (\S+)`),
		regexp.MustCompile(`(?m)^\s*\d+\) (.+)$`),
	}
	tapDirective = regexp.MustCompile(`\s+#\s.*$`)
)

// Class reports whether line looks like a passing, failing or skipped test.
func Class(line string) Line {
	switch {
	case skipLine.MatchString(line):
		return LineSkip
	case failLine.MatchString(line):
		return LineFail
	case passLine.MatchString(line):
		return LinePass
	}
	return LineOther
}

// failureName is the first failing test name, with a TAP directive removed.
func failureName(text string) string {
	for _, re := range failureNameREs {
		m := re.FindStringSubmatch(text)
		if m == nil {
			continue
		}
		return tapDirective.ReplaceAllString(m[1], "")
	}
	return ""
}
