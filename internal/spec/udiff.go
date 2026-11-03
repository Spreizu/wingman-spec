package spec

import (
	"fmt"
	"strings"
)

// Unified is a unified diff of old -> new for path, or "" when they are equal.
func Unified(path, old, neu string) string {
	if old == neu {
		return ""
	}
	a := strings.Split(strings.ReplaceAll(old, "\r\n", "\n"), "\n")
	b := strings.Split(strings.ReplaceAll(neu, "\r\n", "\n"), "\n")
	var out strings.Builder
	fmt.Fprintf(&out, "--- a/%s\n+++ b/%s\n", path, path)
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		if i < len(a) && j < len(b) && a[i] == b[j] {
			fmt.Fprintf(&out, " %s\n", a[i])
			i++
			j++
			continue
		}
		if i < len(a) && (j >= len(b) || a[i] != b[j]) {
			fmt.Fprintf(&out, "-%s\n", a[i])
			i++
			if j < len(b) && (i >= len(a) || a[i] != b[j]) {
				fmt.Fprintf(&out, "+%s\n", b[j])
				j++
			}
			continue
		}
		if j < len(b) {
			fmt.Fprintf(&out, "+%s\n", b[j])
			j++
		}
	}
	return out.String()
}
