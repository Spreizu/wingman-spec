package quality

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSpecWritingSkillNamesVagueWords(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..")
	b, err := os.ReadFile(filepath.Join(root, "skills", "spec-writing", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, w := range []string{"gracefully", "properly", "appropriately", "as expected"} {
		if !strings.Contains(s, w) {
			t.Errorf("spec-writing SKILL.md must name the linter hedge %q", w)
		}
	}
}

func TestForkedSkillsHaveNoSuperpowersPrefix(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "skills")
	ents, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		if strings.Contains(string(b), "superpowers:") {
			t.Errorf("%s/SKILL.md still names superpowers:", e.Name())
		}
	}
}

func TestForkedSkillsUseWingmanPrefix(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "skills")
	want := []string{
		"wingman-test-driven-development",
		"wingman-systematic-debugging",
		"wingman-requesting-code-review",
		"wingman-verification-before-completion",
		"wingman-grilling",
		"wingman-ponytail",
		"wingman-ponytail-review",
	}
	for _, n := range want {
		b, err := os.ReadFile(filepath.Join(root, n, "SKILL.md"))
		if err != nil {
			t.Errorf("%s: %v", n, err)
			continue
		}
		if !strings.Contains(string(b), "name: "+n) {
			t.Errorf("%s/SKILL.md name does not match the folder", n)
		}
	}
	for _, n := range []string{
		"test-driven-development",
		"systematic-debugging",
		"requesting-code-review",
		"verification-before-completion",
		"grilling",
		"ponytail",
		"ponytail-review",
	} {
		if _, err := os.Stat(filepath.Join(root, n)); err == nil {
			t.Errorf("unprefixed folder %s is still present", n)
		}
	}
}
