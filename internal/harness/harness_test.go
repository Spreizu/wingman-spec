package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"go.yaml.in/yaml/v3"
)

var src = fstest.MapFS{
	"commands/spec-a.md": {Data: []byte("---\ndescription: \"Do a\"\nargument-hint: \"<x>\"\n---\nRun /spec-b next.\n{{> p}}\n")},
	"agents/spec-r.md":   {Data: []byte("---\nname: spec-r\ndescription: \"Reads; see /spec-a\"\nreadonly: true\n---\nRead only.\n")},
	"partials/p.md":      {Data: []byte("partial line\n")},
	"AGENTS.block.md":    {Data: []byte(BlockStart + "\nblock\n" + BlockEnd + "\n")},
	"skills/s/SKILL.md":  {Data: []byte("skill\n")},
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
		".claude/commands/spec-a.md":     "argument-hint: \"<x>\"\n---\nRun /spec-b next.\npartial line\n",
		".agents/skills/spec-a/SKILL.md": "---\n# " + mark + "commands/spec-a.md; edits are overwritten on update\nname: spec-a\ndescription: \"Do a\"\n---\nInvoke as `/spec-a <x>` (Cursor) or `$spec-a <x>` (Codex); in Codex every `/spec-` command below is `$spec-`.\n\nRun /spec-b next.\npartial line\n",
		".cursor/agents/spec-r.md":       "model: inherit\nreadonly: true\n",
		".claude/agents/spec-r.md":       "tools: Read, Grep, Glob\n",
		".codex/agents/spec-r.toml":      "description = \"Reads; see $spec-a\"\n",
	} {
		if !strings.Contains(got[p], want) {
			t.Errorf("%s:\n%s\nwant it to contain %q", p, got[p], want)
		}
	}
	// the generated-file note sits in the frontmatter (a YAML comment the harness strips), never in the body the chat shows
	for p, f := range got {
		if strings.HasSuffix(p, ".toml") {
			continue
		}
		parts := strings.SplitN(f, "---\n", 3)
		if len(parts) != 3 || parts[0] != "" || !strings.Contains(parts[1], "# "+mark) || strings.Contains(parts[2], mark) || strings.Contains(parts[2], "<!--") {
			t.Errorf("%s: want the note as a frontmatter comment only:\n%s", p, f)
		}
		var fm map[string]string
		if err := yaml.Unmarshal([]byte(parts[1]), &fm); err != nil || fm["description"] == "" {
			t.Errorf("%s: frontmatter does not parse as YAML with a description: %v", p, err)
		}
	}
	// Cursor and Codex share the .agents/skills command files byte for byte; Cursor gets no commands folder of its own
	cur, _ := Render(src, "cursor")
	cdx, _ := Render(src, "codex")
	if string(cur[0].Data) != string(cdx[0].Data) || cur[0].Path != cdx[0].Path {
		t.Errorf("cursor and codex render different command files: %s %s", cur[0].Path, cdx[0].Path)
	}
	for p := range got {
		if strings.HasPrefix(p, ".cursor/commands/") || strings.HasPrefix(p, ".cursor/skills/") {
			t.Errorf("rendered %s", p)
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
	skills := fsSub(src)
	exe, _ := os.Executable()
	for range 2 {
		if _, err := Install(d, src, skills, Options{Harnesses: Names, Exe: exe}); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{".claude/skills/s/SKILL.md", ".agents/skills/s/SKILL.md", "CLAUDE.md", ShimFile()} {
		if _, err := os.Stat(filepath.Join(d, p)); err != nil {
			t.Error(err)
		}
	}
	if _, err := os.Stat(filepath.Join(d, ".cursor/skills")); err == nil {
		t.Error("Cursor got its own skills folder; it reads .agents/skills")
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
	// a generated file of an older version is removed from the folders init still writes; a file the user wrote is kept,
	// and so are the .cursor/commands and .cursor/skills of 0.12 (deleting those is the developer's call)
	stale := filepath.Join(d, ".claude/commands/spec-old.md")
	_ = os.WriteFile(stale, []byte("<!-- "+mark+"commands/spec-old.md -->\n"), 0o644)
	old := filepath.Join(d, ".claude/commands/spec-next.md") // 0.10's, written by install.sh
	_ = os.WriteFile(old, []byte("<!-- "+oldMark+"commands/spec-next.md; edits are overwritten on reinstall -->\n"), 0o644)
	gone := filepath.Join(d, ".agents/skills/spec-gone/SKILL.md") // this version's note, in the frontmatter
	_ = os.MkdirAll(filepath.Dir(gone), 0o755)
	_ = os.WriteFile(gone, []byte("---\n# "+mark+"commands/spec-gone.md; edits are overwritten on update\ndescription: \"x\"\n---\nx\n"), 0o644)
	cur := filepath.Join(d, ".claude/commands/spec-a.md") // the 0.12 HTML-comment note is replaced by the frontmatter one
	_ = os.WriteFile(cur, []byte("---\ndescription: \"Do a\"\n---\n<!-- "+mark+"commands/spec-a.md; edits are overwritten on update -->\nold\n"), 0o644)
	mine := filepath.Join(d, ".claude/commands/mine.md")
	_ = os.WriteFile(mine, []byte("---\n# my own command\ndescription: \"mine\"\n---\n<!-- keep -->\nmine\n"), 0o644)
	legacy := map[string]string{
		".cursor/commands/spec-a.md":   "---\n# " + mark + "commands/spec-a.md; edits are overwritten on update\ndescription: \"Do a\"\n---\nold\n",
		".cursor/commands/spec-old.md": "<!-- " + mark + "commands/spec-old.md -->\n",
		".cursor/skills/s/SKILL.md":    "skill\n",
	}
	for p, b := range legacy {
		if err := writeFile(filepath.Join(d, p), []byte(b)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Install(d, src, skills, Options{Harnesses: []string{"cursor", "claude"}}); err != nil {
		t.Fatal(err)
	}
	for p, want := range legacy {
		if b, _ := os.ReadFile(filepath.Join(d, p)); string(b) != want {
			t.Errorf("%s of an older version was changed or removed: %q", p, b)
		}
	}
	if _, err := os.Stat(gone); err == nil {
		t.Error("stale generated file with the frontmatter note kept")
	}
	if b, _ := os.ReadFile(cur); strings.Contains(string(b), "<!--") || !strings.HasPrefix(string(b), "---\n# "+mark) {
		t.Errorf("update left the old note: %q", b)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("stale generated file kept")
	}
	if _, err := os.Stat(old); err == nil {
		t.Error("0.10 generated file kept")
	}
	if b, _ := os.ReadFile(mine); string(b) != "---\n# my own command\ndescription: \"mine\"\n---\n<!-- keep -->\nmine\n" {
		t.Errorf("user file changed or removed: %q", b)
	}
}

// Stale names a generated file and AGENTS.md once they differ from what update writes, and nothing after update.
func TestStale(t *testing.T) {
	d := t.TempDir()
	if _, err := Install(d, src, fsSub(src), Options{Harnesses: []string{"cursor"}}); err != nil {
		t.Fatal(err)
	}
	if got, err := Stale(d, src, []string{"cursor"}); err != nil || len(got) != 0 {
		t.Fatalf("fresh install: %v %v", got, err)
	}
	_ = os.WriteFile(filepath.Join(d, ".agents/skills/spec-a/SKILL.md"), []byte("old\n"), 0o644)
	_ = os.WriteFile(filepath.Join(d, "AGENTS.md"), []byte("mine\n"), 0o644)
	if got, _ := Stale(d, src, []string{"cursor"}); strings.Join(got, ",") != "AGENTS.md,.agents/skills/spec-a/SKILL.md" {
		t.Errorf("Stale = %v", got)
	}
	if got, _ := Stale(d, src, nil); len(got) != 0 {
		t.Errorf("no harness: %v", got)
	}
}

// After init the editor shows no Update button: the files init wrote are what update writes, for every harness, and
// a .cursor/commands or .cursor/skills left by 0.12 changes nothing. A folder the developer deleted is not offered back;
// a command this version added to a folder that exists is.
func TestStaleAfterInit(t *testing.T) {
	d := t.TempDir()
	for p, b := range map[string]string{".cursor/commands/spec-a.md": "old\n", ".cursor/skills/s/SKILL.md": "old\n"} {
		_ = writeFile(filepath.Join(d, p), []byte(b))
	}
	if _, err := Install(d, src, fsSub(src), Options{Harnesses: Names}); err != nil {
		t.Fatal(err)
	}
	if got, err := Stale(d, src, Names); err != nil || len(got) != 0 {
		t.Fatalf("right after init: %v %v", got, err)
	}
	_ = os.RemoveAll(filepath.Join(d, ".codex"))
	_ = os.RemoveAll(filepath.Join(d, ".claude/agents"))
	if got, _ := Stale(d, src, Names); len(got) != 0 {
		t.Errorf("deleted folders reported stale: %v", got)
	}
	_ = os.RemoveAll(filepath.Join(d, ".agents/skills/spec-a"))
	if got, _ := Stale(d, src, Names); strings.Join(got, ",") != ".agents/skills/spec-a/SKILL.md" {
		t.Errorf("a missing command in .agents/skills: %v", got)
	}
}

// Installed knows a harness by a file only it has: the shared .agents/skills alone is no tool, and Cursor installs of
// 0.12 (commands in .cursor/commands) still count.
func TestInstalled(t *testing.T) {
	d := t.TempDir()
	_ = writeFile(filepath.Join(d, ".agents/skills/spec-apply/SKILL.md"), nil)
	if got := Installed(d); len(got) != 0 {
		t.Errorf(".agents/skills alone: %v", got)
	}
	_ = writeFile(filepath.Join(d, ".cursor/commands/spec-apply.md"), nil)
	_ = writeFile(filepath.Join(d, ".codex/agents/spec-implementer.toml"), nil)
	if got := Installed(d); strings.Join(got, ",") != "cursor,codex" {
		t.Errorf("Installed = %v", got)
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

func fsSub(f fstest.MapFS) fstest.MapFS {
	out := fstest.MapFS{}
	for k, v := range f {
		if rest, ok := strings.CutPrefix(k, "skills/"); ok {
			out[rest] = v
		}
	}
	return out
}

// Hook files are the user's: init neither registers a hook nor removes the 0.11 spec-guard.cjs entry or script.
func TestInstallLeavesHookFilesAlone(t *testing.T) {
	d := t.TempDir()
	skills := fsSub(src)
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

func TestInstallRemovesOldUnprefixedSkills(t *testing.T) {
	d := t.TempDir()
	ours := filepath.Join(d, ".agents/skills/ponytail/SKILL.md")
	theirs := filepath.Join(d, ".agents/skills/test-driven-development/SKILL.md")
	if err := writeFile(ours, []byte("Loaded by spec-implementer for every implementation task.\n")); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(theirs, []byte("Use TDD. Write a failing test first.\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(d, src, fsSub(src), Options{Harnesses: []string{"cursor"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(ours)); err == nil {
		t.Error("bundled unprefixed ponytail was kept")
	}
	if _, err := os.Stat(theirs); err != nil {
		t.Error("user's own test-driven-development was removed")
	}
	if _, err := os.Stat(filepath.Join(d, ".agents/skills/s/SKILL.md")); err != nil {
		t.Error("bundled skill was not installed")
	}
}
