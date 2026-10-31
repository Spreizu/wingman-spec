package visual

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteBundle(t *testing.T) {
	if !bytes.HasPrefix(bundle, []byte("#!/usr/bin/env node")) || len(bundle) < 10000 {
		t.Fatalf("embedded bundle looks wrong (%d bytes)", len(bundle))
	}
	dir := filepath.Join(t.TempDir(), "bin")
	p, err := writeBundle(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(got, bundle) {
		t.Fatalf("written bundle differs: %v", err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := writeBundle(dir); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(p); !st.ModTime().Equal(old) {
		t.Error("an up-to-date bundle was rewritten")
	}
	if err := os.WriteFile(p, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := writeBundle(dir); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, bundle) {
		t.Error("a stale bundle was not replaced")
	}
}
