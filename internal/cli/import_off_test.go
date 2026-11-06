//go:build !importer

package cli

import (
	"strings"
	"testing"
)

func TestImportOpenSpecNeedsTag(t *testing.T) {
	dir := t.TempDir()
	r := run(t, dir, "import", "openspec")
	if r.code == 0 || !strings.Contains(r.err, "-tags importer") {
		t.Fatalf("import without the tag = %+v", r)
	}
}
