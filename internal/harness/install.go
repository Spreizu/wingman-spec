package harness

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// Options of Install.
type Options struct {
	Harnesses []string // cursor, claude, codex
	Exe       string   // the wingman-spec binary the shim points at
}

// Result lists what Install did, one human line per file or step.
type Result struct {
	Lines []string `json:"lines"`
}

func (r *Result) say(f string, a ...any) { r.Lines = append(r.Lines, fmt.Sprintf(f, a...)) }

// Shim is the path, relative to the project, that the generated commands run.
const Shim = ".wingman-spec/bin/wingman-spec"

// ShimFile is the shim's file on this platform: Shim, or Shim.cmd on Windows.
func ShimFile() string {
	if runtime.GOOS == "windows" {
		return Shim + ".cmd"
	}
	return Shim
}

// Block markers of the managed AGENTS.md section.
const (
	BlockStart = "<!-- WINGMAN-SPEC:START -->"
	BlockEnd   = "<!-- WINGMAN-SPEC:END -->"
)

var skillDirs = map[string]string{"cursor": ".cursor/skills", "claude": ".claude/skills", "codex": ".agents/skills"}

// skipSkillFile reports the authoring-only files of a vendored skill (not instructions; not installed).
func skipSkillFile(name string) bool {
	return name == "CREATION-LOG.md" || name == "test-academic.md" || strings.HasPrefix(name, "test-pressure-") || name == "VENDORED.md" || name == "vendor.lock"
}

// Installed lists the harnesses whose generated files exist in dir.
func Installed(dir string) []string {
	var out []string
	for _, h := range Names {
		p := map[string]string{"cursor": ".cursor/commands/spec-apply.md", "claude": ".claude/commands/spec-apply.md", "codex": ".agents/skills/spec-apply/SKILL.md"}[h]
		if _, err := os.Stat(filepath.Join(dir, p)); err == nil {
			out = append(out, h)
		}
	}
	return out
}

// ParseList reads --harness: a comma list of cursor, claude, codex, or all.
func ParseList(s string) ([]string, error) {
	if s == "" {
		return nil, nil
	}
	if s == "all" {
		return slices.Clone(Names), nil
	}
	var out []string
	for h := range strings.SplitSeq(s, ",") {
		h = strings.TrimSpace(h)
		if !slices.Contains(Names, h) {
			return nil, fmt.Errorf("--harness %q: use cursor, claude, codex (comma separated) or all", h)
		}
		if !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out, nil
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

// writeIfChanged writes b unless the file already holds exactly b.
func writeIfChanged(p string, b []byte, mode os.FileMode) error {
	if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, b) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, b, mode); err != nil {
		return err
	}
	return os.Chmod(p, mode)
}

// Install writes everything for opts.Harnesses into dir (the code repository). Generated files are overwritten;
// the user's own files (AGENTS.md, CLAUDE.md, hook files) only gain the managed parts.
func Install(dir string, src, skills fs.FS, o Options) (*Result, error) {
	r := &Result{}
	if err := WriteShim(dir, o.Exe); err != nil {
		return nil, err
	}
	r.say("shim        -> %s", ShimFile())
	if err := Block(dir, src); err != nil {
		return nil, err
	}
	r.say("AGENTS.md   -> managed block current")
	for _, h := range o.Harnesses {
		files, err := Render(src, h)
		if err != nil {
			return nil, err
		}
		keep := map[string]bool{}
		for _, f := range files {
			keep[f.Path] = true
			if err := writeIfChanged(filepath.Join(dir, filepath.FromSlash(f.Path)), f.Data, 0o644); err != nil {
				return nil, err
			}
		}
		removed, err := prune(dir, h, keep)
		if err != nil {
			return nil, err
		}
		r.say("%-11s -> %d generated files%s", h, len(files), map[bool]string{true: fmt.Sprintf(" (%d stale removed)", removed), false: ""}[removed > 0])
		n, err := installSkills(dir, skills, skillDirs[h])
		if err != nil {
			return nil, err
		}
		r.say("skills      -> %d bundled skills in %s", n, skillDirs[h])
		if h == "claude" {
			if err := claudeImport(dir); err != nil {
				return nil, err
			}
		}
	}
	return r, nil
}

// Stale lists the generated files of hs in dir that `update` would rewrite (missing or different), and AGENTS.md when
// its managed block is not current. Nothing is written.
func Stale(dir string, src fs.FS, hs []string) ([]string, error) {
	var out []string
	if len(hs) > 0 {
		block, err := fs.ReadFile(src, "AGENTS.block.md")
		if err != nil {
			return nil, err
		}
		if b, err := os.ReadFile(filepath.Join(dir, "AGENTS.md")); err != nil || !bytes.Contains(b, block) {
			out = append(out, "AGENTS.md")
		}
	}
	for _, h := range hs {
		files, err := Render(src, h)
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f.Path))); err != nil || !bytes.Equal(b, f.Data) {
				out = append(out, f.Path)
			}
		}
	}
	return out, nil
}

// oldMark is the generated-file note of 0.11 and earlier (install.sh); their spec-next, spec-plan, spec-start are gone.
const oldMark = "generated by the wingman-spec install.sh from harness/"

// prune removes generated files of an earlier version that the current harness no longer renders.
func prune(dir, h string, keep map[string]bool) (int, error) {
	globs := map[string][]string{
		"cursor": {".cursor/commands/*.md", ".cursor/agents/*.md"},
		"claude": {".claude/commands/*.md", ".claude/agents/*.md"},
		"codex":  {".agents/skills/*/SKILL.md", ".codex/agents/*.toml"},
	}[h]
	n := 0
	for _, g := range globs {
		ms, _ := filepath.Glob(filepath.Join(dir, filepath.FromSlash(g)))
		for _, m := range ms {
			rel, _ := filepath.Rel(dir, m)
			if keep[filepath.ToSlash(rel)] {
				continue
			}
			b, err := os.ReadFile(m)
			if err != nil || !bytes.Contains(b, []byte(mark)) && !bytes.Contains(b, []byte(oldMark)) {
				continue
			}
			if err := os.Remove(m); err != nil {
				return n, err
			}
			if h == "codex" && strings.HasSuffix(m, "SKILL.md") {
				_ = os.Remove(filepath.Dir(m)) // only when empty
			}
			n++
		}
	}
	return n, nil
}

func installSkills(dir string, skills fs.FS, destRoot string) (int, error) {
	ents, err := fs.ReadDir(skills, ".")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		if _, err := fs.Stat(skills, e.Name()+"/SKILL.md"); err != nil {
			continue
		}
		dest := filepath.Join(dir, filepath.FromSlash(destRoot), e.Name())
		if err := os.RemoveAll(dest); err != nil {
			return n, err
		}
		err := fs.WalkDir(skills, e.Name(), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || skipSkillFile(d.Name()) {
				return err
			}
			b, err := fs.ReadFile(skills, p)
			if err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if strings.HasSuffix(p, ".sh") || strings.Contains(p, "/scripts/") {
				mode = 0o755
			}
			return writeIfChanged(filepath.Join(dir, filepath.FromSlash(destRoot), filepath.FromSlash(p)), b, mode)
		})
		if err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// WriteShim points .wingman-spec/bin/wingman-spec at exe: a symlink, or a .cmd file on Windows.
// A shim that already points at exe is left alone; an empty exe writes nothing.
func WriteShim(dir, exe string) error {
	if exe == "" {
		return nil
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	p := filepath.Join(dir, filepath.FromSlash(Shim))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return writeIfChanged(filepath.Join(dir, filepath.FromSlash(ShimFile())), []byte("@\""+exe+"\" %*\r\n"), 0o644)
	}
	if cur, err := os.Readlink(p); err == nil && cur == exe {
		return nil
	}
	if same, err := filepath.EvalSymlinks(p); err == nil && same == exe {
		return nil // the running binary is the shim's target already (run through the shim)
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Symlink(exe, p)
}

// Block writes the managed section of AGENTS.md: appended once, then only the lines between the markers change.
func Block(dir string, src fs.FS) error {
	block, err := fs.ReadFile(src, "AGENTS.block.md")
	if err != nil {
		return err
	}
	p := filepath.Join(dir, "AGENTS.md")
	old, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return writeFile(p, block)
	} else if err != nil {
		return err
	}
	text := string(old)
	start, end := strings.Count(text, BlockStart), strings.Count(text, BlockEnd)
	if start == 0 && end == 0 {
		if !strings.HasSuffix(text, "\n") && text != "" {
			text += "\n"
		}
		return writeIfChanged(p, []byte(text+"\n"+string(block)), 0o644)
	}
	if start != 1 || end != 1 || strings.Index(text, BlockEnd) < strings.Index(text, BlockStart) {
		return fmt.Errorf("AGENTS.md: the %s / %s markers are unbalanced; fix them by hand", BlockStart, BlockEnd)
	}
	s := strings.Index(text, BlockStart)
	i := strings.LastIndex(text[:s], "\n") + 1 // start of the marker's line
	j := strings.Index(text, BlockEnd)
	k := strings.Index(text[j:], "\n")
	rest := ""
	if k >= 0 {
		rest = text[j+k+1:]
	}
	out := text[:i] + string(block) + rest
	if !strings.HasSuffix(text, "\n") && strings.HasSuffix(out, "\n") {
		out = strings.TrimSuffix(out, "\n")
	}
	return writeIfChanged(p, []byte(out), 0o644)
}

// claudeImport makes CLAUDE.md import AGENTS.md (Claude Code does not read AGENTS.md by itself).
func claudeImport(dir string) error {
	p := filepath.Join(dir, "CLAUDE.md")
	old, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return writeFile(p, []byte("@AGENTS.md\n"))
	} else if err != nil {
		return err
	}
	for l := range strings.SplitSeq(string(old), "\n") {
		if strings.TrimRight(l, "\r") == "@AGENTS.md" {
			return nil
		}
	}
	text := string(old)
	if len(text) > 0 && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return writeFile(p, []byte(text+"\n@AGENTS.md\n"))
}

// Workspace adds the code and specs folders to a .code-workspace file (created when missing).
func Workspace(file, code, specs string) (string, error) {
	base := filepath.Dir(file)
	rel := func(p string) string {
		r, err := filepath.Rel(base, p)
		if err != nil || r == "" {
			return "."
		}
		return filepath.ToSlash(r)
	}
	want := []struct{ name, path string }{{"code: " + filepath.Base(code), code}, {"specs: " + filepath.Base(specs), specs}}
	var added []string
	bad := false
	res, err := patchJSON(file, func(j *jv) bool {
		folders := j.get("folders")
		if folders == nil {
			folders = j.child("folders", arr())
		}
		if folders.kind != '[' {
			bad = true
			return false
		}
		for _, w := range want {
			have := false
			for _, f := range folders.arr {
				if f.kind == '{' && f.get("path") != nil {
					var s string
					if v := f.get("path"); v.kind == 0 && strings.HasPrefix(v.raw, `"`) {
						s = strings.Trim(v.raw, `"`)
					}
					if filepath.Clean(filepath.Join(base, s)) == filepath.Clean(w.path) {
						have = true
					}
				}
			}
			if !have {
				folders.arr = append(folders.arr, obj("name", str(w.name), "path", str(rel(w.path))))
				added = append(added, w.name)
			}
		}
		return len(added) > 0
	})
	if err != nil {
		return "", err
	}
	if bad {
		res = Manual
	}
	switch res {
	case Created:
		return "workspace   -> " + file + " (code + specs folders)", nil
	case Same:
		return "workspace   -> " + file + " already lists the folders (left untouched)", nil
	case Manual:
		return "workspace   -> " + file + " exists (left untouched; add the folder " + code + " to it by hand)", nil
	}
	return "workspace   -> " + file + " exists; added folder " + strings.Join(added, ", "), nil
}
