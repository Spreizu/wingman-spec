package codeindex

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestScanReads(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("// @spec demo/a\npackage a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "x.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx := Scan(dir, func(f string) bool { return strings.HasSuffix(f, ".go") })
	if idx.Text("a.go") == "" || !strings.Contains(idx.Text("a.go"), "@spec") {
		t.Fatalf("a.go text %q", idx.Text("a.go"))
	}
	for _, f := range idx.RelPaths() {
		if strings.Contains(f, "node_modules") {
			t.Fatalf("walked vendor path %s", f)
		}
	}
}

func TestScanSkippedUnreadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode 0 files stay readable on Windows")
	}
	dir := t.TempDir()
	hidden := filepath.Join(dir, "secret.go")
	if err := os.WriteFile(hidden, []byte("package secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hidden, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(hidden, 0o644) })
	idx := Scan(dir, func(f string) bool { return strings.HasSuffix(f, ".go") })
	if os.Getuid() == 0 {
		t.Skip("root can read mode 0 files")
	}
	found := false
	for _, s := range idx.Skipped {
		if s.File == "secret.go" && s.Why != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("skipped = %#v", idx.Skipped)
	}
}

func BenchmarkScan(b *testing.B) {
	dir := b.TempDir()
	for i := range 50 {
		name := filepath.Join(dir, "f"+string(rune('a'+i%26))+".go")
		if err := os.WriteFile(name, []byte("package p\n// @spec cap/req\n"), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	for b.Loop() {
		Scan(dir, func(string) bool { return true })
	}
}
