package visual

import (
	"bytes"
	_ "embed"
	"os"
	"path/filepath"
)

// BundleName is the file name of the embedded helper once written out.
const BundleName = "wingman-visual.mjs"

// bundle is the helper (visual/ bundled by scripts/build-visual.mjs): one ES module, Playwright and axe-core left out.
//
//go:embed bundle/wingman-visual.mjs
var bundle []byte

// writeBundle writes the embedded helper to dir/wingman-visual.mjs unless the same bytes are already there (a CLI update
// replaces it on its next use) and returns its path.
func writeBundle(dir string) (string, error) {
	p := filepath.Join(dir, BundleName)
	if cur, err := os.ReadFile(p); err == nil && bytes.Equal(cur, bundle) {
		return p, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".wingman-visual-*.mjs")
	if err != nil {
		return "", err
	}
	if _, err := tmp.Write(bundle); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return p, nil
}

// embeddedHelper writes the embedded helper to <code root>/.wingman-spec/bin (gitignored), or to the user cache directory
// when there is no code root or it is read-only.
func embeddedHelper(codeRoot string) (string, error) {
	var dirs []string
	if codeRoot != "" {
		dirs = append(dirs, filepath.Join(codeRoot, ".wingman-spec", "bin"))
	}
	if c, err := os.UserCacheDir(); err == nil {
		dirs = append(dirs, filepath.Join(c, "wingman-spec"))
	}
	last := ErrNoHelper
	for _, d := range dirs {
		p, err := writeBundle(d)
		if err == nil {
			return p, nil
		}
		last = err
	}
	return "", last
}
