package layout

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFind(t *testing.T) {
	base := t.TempDir()
	inRepo := filepath.Join(base, "app")
	write(t, filepath.Join(inRepo, Dir, ConfigFile), "context: x\n")
	specsRepo := filepath.Join(base, "specs")
	write(t, filepath.Join(specsRepo, ConfigFile), "repos:\n  web: ../web\n")
	linked := filepath.Join(base, "web")
	write(t, filepath.Join(linked, Dir, ConfigFile), "specs: ../specs   # the specs repo\nspecs_remote: https://u:p@example.com/specs.git\n")
	if err := os.MkdirAll(filepath.Join(linked, "src", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name, start string
		kind        Kind
		code, specs string
		configs     int
		remote      string
	}{
		{"in-repo", inRepo, InRepo, inRepo, filepath.Join(inRepo, Dir), 1, ""},
		{"specs repo", specsRepo, SpecsRepo, specsRepo, specsRepo, 1, ""},
		{"linked from a subdirectory", filepath.Join(linked, "src", "deep"), Linked, linked, specsRepo, 2, "https://example.com/specs.git"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := Find(tt.start, "")
			if err != nil {
				t.Fatalf("Find: %v", err)
			}
			if r.Kind != tt.kind || r.Code != tt.code || r.Specs != tt.specs || len(r.Configs) != tt.configs || r.Remote != tt.remote {
				t.Errorf("Find(%s) = %+v", tt.start, r)
			}
		})
	}
}

func TestFindMissingSpecs(t *testing.T) {
	base := t.TempDir()
	write(t, filepath.Join(base, "web", Dir, ConfigFile), "specs: ../gone\n")
	_, err := Find(filepath.Join(base, "web"), "")
	miss, ok := errors.AsType[*MissingSpecsError](err)
	if !ok || miss.Dir != filepath.Join(base, "gone") {
		t.Fatalf("err = %v, want MissingSpecsError for ../gone", err)
	}
}

func TestFindNone(t *testing.T) {
	if _, err := Find(t.TempDir(), ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestFindOverride(t *testing.T) {
	base := t.TempDir()
	specs := filepath.Join(base, "specs")
	write(t, filepath.Join(specs, ConfigFile), "")
	code := filepath.Join(base, "web")
	write(t, filepath.Join(code, Dir, ConfigFile), "commands:\n  test: none\n")
	r, err := Find(code, specs)
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != Linked || r.Code != code || r.Specs != specs || len(r.Configs) != 2 {
		t.Fatalf("got %+v", r)
	}
}

func TestCleanURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://user:pw@host/x.git": "https://host/x.git",
		"git@host:x.git":             "git@host:x.git",
		"https://host/a@b":           "https://host/a@b",
	} {
		if got := CleanURL(in); got != want {
			t.Errorf("CleanURL(%q) = %q, want %q", in, got, want)
		}
	}
}
