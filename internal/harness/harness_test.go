package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

var src = fstest.MapFS{
	"commands/spec-a.md":        {Data: []byte("---\ndescription: \"Do a\"\nargument-hint: \"<x>\"\n---\nRun /spec-b next.\n{{> p}}\n")},
	"agents/spec-r.md":          {Data: []byte("---\nname: spec-r\ndescription: \"Reads; see /spec-a\"\nreadonly: true\n---\nRead only.\n")},
	"partials/p.md":             {Data: []byte("partial line\n")},
	"AGENTS.block.md":           {Data: []byte(BlockStart + "\nblock\n" + BlockEnd + "\n")},
	"skills/s/SKILL.md":         {Data: []byte("skill\n")},
	"skills/s/test-academic.md": {Data: []byte("x")},
}

func TestRender(t *testing.T) {
	got := map[string]string{}
	for _, h := range Names {
		fs, err := Render(src, h)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range fs {
			got[f.Path] = string(f.Data)
		}
	}
	for p, want := range map[string]string{
		".cursor/commands/spec-a.md":     "---\ndescription: \"Do a\"\n---\n<!-- " + mark + "commands/spec-a.md; edits are overwritten on update -->\nRun /spec-b next.\npartial line\n",
		".claude/commands/spec-a.md":     "argument-hint: \"<x>\"\n",
		".agents/skills/spec-a/SKILL.md": "Invoke as `$spec-a <x>`.\n\nRun $spec-b next.\n",
		".cursor/agents/spec-r.md":       "model: inherit\nreadonly: true\n",
		".claude/agents/spec-r.md":       "tools: Read, Grep, Glob\n",
		".codex/agents/spec-r.toml":      "description = \"Reads; see $spec-a\"\n",
	} {
		if !strings.Contains(got[p], want) {
			t.Errorf("%s:\n%s\nwant it to contain %q", p, got[p], want)
		}
	}
	if !strings.HasSuffix(got[".codex/agents/spec-r.toml"], "developer_instructions = '''\nRead only.\n'''\n\n[features]\nshell_tool = false\n") {
		t.Errorf("codex agent: %q", got[".codex/agents/spec-r.toml"])
	}
}

func TestPatchJSON(t *testing.T) {
	d := t.TempDir()
	add := func(j *jv) bool {
		j.child("hooks", obj()).child("x", arr()).arr = append(j.child("hooks", obj()).child("x", arr()).arr, str("é<"))
		return true
	}
	for _, tt := range []struct{ name, in, want, res string }{
		{"4-space, own key order", "{\n    \"z\": 1,\n    \"a\": [\n        true\n    ]\n}\n", "{\n    \"z\": 1,\n    \"a\": [\n        true\n    ],\n    \"hooks\": {\n        \"x\": [\n            \"é<\"\n        ]\n    }\n}\n", Written},
		{"tab, CRLF, no final newline", "{\r\n\t\"a\": {}\r\n}", "{\r\n\t\"a\": {},\r\n\t\"hooks\": {\r\n\t\t\"x\": [\r\n\t\t\t\"é<\"\r\n\t\t]\r\n\t}\r\n}", Written},
		{"compact", `{"hooks":{}}`, `{"hooks":{}}`, Manual},
		{"comments", "{\n  // c\n  \"a\": 1\n}\n", "{\n  // c\n  \"a\": 1\n}\n", Manual},
		{"aligned", "{\n  \"a\": { \"b\": 1 }\n}\n", "{\n  \"a\": { \"b\": 1 }\n}\n", Manual},
	} {
		p := filepath.Join(d, "f.json")
		if err := os.WriteFile(p, []byte(tt.in), 0o644); err != nil {
			t.Fatal(err)
		}
		res, err := patchJSON(p, add)
		b, _ := os.ReadFile(p)
		if err != nil || res != tt.res || string(b) != tt.want {
			t.Errorf("%s: %s %v\n%q", tt.name, res, err, b)
		}
	}
}

func TestBlock(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "AGENTS.md")
	for _, tt := range []struct{ name, in, want string }{
		{"new", "", BlockStart + "\nblock\n" + BlockEnd + "\n"},
		{"appended, CRLF kept", "# Ours\r\nBe kind.", "# Ours\r\nBe kind.\n\n" + BlockStart + "\nblock\n" + BlockEnd + "\n"},
		{"replaced between markers, no final newline kept", "a\n" + BlockStart + "\nold\n" + BlockEnd + "\nafter", "a\n" + BlockStart + "\nblock\n" + BlockEnd + "\nafter"},
	} {
		_ = os.Remove(p)
		if tt.in != "" {
			_ = os.WriteFile(p, []byte(tt.in), 0o644)
		}
		if err := Block(d, src); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(p)
		if string(b) != tt.want {
			t.Errorf("%s: %q", tt.name, b)
		}
	}
	_ = os.WriteFile(p, []byte(BlockStart+"\n"), 0o644)
	if err := Block(d, src); err == nil {
		t.Error("unbalanced markers: want an error")
	}
}

func TestInstall(t *testing.T) {
	d := t.TempDir()
	skills := fsSub(src, "skills")
	exe, _ := os.Executable()
	for range 2 {
		if _, err := Install(d, src, skills, Options{Harnesses: Names, Exe: exe}); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{".cursor/skills/s/SKILL.md", ".agents/skills/s/SKILL.md", "CLAUDE.md", Shim} {
		if _, err := os.Stat(filepath.Join(d, p)); err != nil {
			t.Error(err)
		}
	}
	if _, err := os.Stat(filepath.Join(d, ".cursor/skills/s/test-academic.md")); err == nil {
		t.Error("authoring-only skill file installed")
	}
	if b, _ := os.ReadFile(filepath.Join(d, "CLAUDE.md")); string(b) != "@AGENTS.md\n" {
		t.Errorf("CLAUDE.md %q", b)
	}
	if _, err := os.Stat(filepath.Join(d, ".cursor/hooks.json")); err == nil {
		t.Error("init wrote a hook file")
	}
	if got := Installed(d); len(got) != 0 { // the test harness has no spec-apply command
		t.Errorf("Installed = %v", got)
	}
	// a generated file of an older version is removed; a file the user wrote is kept
	stale := filepath.Join(d, ".cursor/commands/spec-old.md")
	_ = os.WriteFile(stale, []byte("<!-- "+mark+"commands/spec-old.md -->\n"), 0o644)
	old := filepath.Join(d, ".cursor/commands/spec-next.md") // 0.10's, written by install.sh
	_ = os.WriteFile(old, []byte("<!-- "+oldMark+"commands/spec-next.md; edits are overwritten on reinstall -->\n"), 0o644)
	mine := filepath.Join(d, ".cursor/commands/mine.md")
	_ = os.WriteFile(mine, []byte("mine\n"), 0o644)
	if _, err := Install(d, src, skills, Options{Harnesses: []string{"cursor"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("stale generated file kept")
	}
	if _, err := os.Stat(old); err == nil {
		t.Error("0.10 generated file kept")
	}
	if _, err := os.Stat(mine); err != nil {
		t.Error("user file removed")
	}
}

// Stale names a generated file and AGENTS.md once they differ from what update writes, and nothing after update.
func TestStale(t *testing.T) {
	d := t.TempDir()
	if _, err := Install(d, src, fsSub(src, "skills"), Options{Harnesses: []string{"cursor"}}); err != nil {
		t.Fatal(err)
	}
	if got, err := Stale(d, src, []string{"cursor"}); err != nil || len(got) != 0 {
		t.Fatalf("fresh install: %v %v", got, err)
	}
	_ = os.WriteFile(filepath.Join(d, ".cursor/commands/spec-a.md"), []byte("old\n"), 0o644)
	_ = os.WriteFile(filepath.Join(d, "AGENTS.md"), []byte("mine\n"), 0o644)
	if got, _ := Stale(d, src, []string{"cursor"}); strings.Join(got, ",") != "AGENTS.md,.cursor/commands/spec-a.md" {
		t.Errorf("Stale = %v", got)
	}
	if got, _ := Stale(d, src, nil); len(got) != 0 {
		t.Errorf("no harness: %v", got)
	}
}

func TestParseList(t *testing.T) {
	if l, err := ParseList("all"); err != nil || len(l) != 3 {
		t.Error(l, err)
	}
	if l, err := ParseList("codex, cursor,codex"); err != nil || strings.Join(l, ",") != "codex,cursor" {
		t.Error(l, err)
	}
	if _, err := ParseList("vim"); err == nil {
		t.Error("vim accepted")
	}
}

func fsSub(f fstest.MapFS, dir string) fstest.MapFS {
	out := fstest.MapFS{}
	for k, v := range f {
		if rest, ok := strings.CutPrefix(k, dir+"/"); ok {
			out[rest] = v
		}
	}
	return out
}

// Hook files are the user's: init neither registers a hook nor removes the 0.11 spec-guard.cjs entry or script.
func TestInstallLeavesHookFilesAlone(t *testing.T) {
	d := t.TempDir()
	skills := fsSub(src, "skills")
	files := map[string]string{
		".cursor/hooks.json":           `{"version":1,"hooks":{"beforeSubmitPrompt":[{"command":"node .cursor/hooks/spec-guard.cjs"}]}}` + "\n",
		".claude/settings.json":        "{\n  \"hooks\": {\n    \"Stop\": [ { \"hooks\": [ { \"type\": \"command\", \"command\": \"echo mine\" } ] } ]\n  }\n}\n",
		".cursor/hooks/spec-guard.cjs": "// 0.11\n",
	}
	for p, body := range files {
		if err := writeFile(filepath.Join(d, p), []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Install(d, src, skills, Options{Harnesses: []string{"cursor", "claude", "codex"}}); err != nil {
		t.Fatal(err)
	}
	for p, body := range files {
		if b, _ := os.ReadFile(filepath.Join(d, p)); string(b) != body {
			t.Errorf("%s changed:\n%s", p, b)
		}
	}
	if _, err := os.Stat(filepath.Join(d, ".codex/hooks.json")); err == nil {
		t.Error("init wrote .codex/hooks.json")
	}
}
