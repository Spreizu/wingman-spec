// Package gitx runs git. Every helper returns ok=false (or nil) instead of an error when git fails or the directory is
// not a repository: the verifier works without git and only loses the checks that need history.
package gitx

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
)

// Run runs git in dir with extra environment variables and returns the trimmed stdout.
func Run(dir string, env []string, args ...string) (string, bool) {
	out, ok := RunRaw(dir, env, nil, args...)
	return strings.TrimSpace(out), ok
}

// RunRaw runs git with optional stdin and returns stdout untrimmed.
func RunRaw(dir string, env []string, stdin []byte, args ...string) (string, bool) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return out.String(), false
	}
	return out.String(), true
}

// Lines runs git and returns the non-empty output lines, or nil when git fails.
func Lines(dir string, args ...string) []string {
	out, ok := RunRaw(dir, nil, nil, args...)
	if !ok {
		return nil
	}
	ls := []string{}
	for l := range strings.SplitSeq(out, "\n") {
		if l != "" {
			ls = append(ls, l)
		}
	}
	return ls
}

// Z runs git and splits its NUL-separated output.
func Z(dir string, env []string, args ...string) ([]string, bool) {
	out, ok := RunRaw(dir, env, nil, args...)
	if !ok {
		return nil, false
	}
	var xs []string
	for x := range strings.SplitSeq(out, "\x00") {
		if x != "" {
			xs = append(xs, x)
		}
	}
	return xs, true
}

// Head is the commit of HEAD ("" without git or commits).
func Head(dir string) string {
	h, ok := Run(dir, nil, "rev-parse", "HEAD")
	if !ok {
		return ""
	}
	return h
}

// IsAncestor reports whether commit a is an ancestor of b.
func IsAncestor(dir, a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	_, ok := Run(dir, nil, "merge-base", "--is-ancestor", a, b)
	return ok
}

// Status is `git status --porcelain --untracked-files=all` as paths (renames give the new path), or nil without git.
func Status(dir string) []string {
	ls := Lines(dir, "status", "--porcelain", "--untracked-files=all")
	if ls == nil {
		return nil
	}
	out := []string{}
	for _, l := range ls {
		if len(l) < 4 {
			continue
		}
		p := l[3:]
		if i := strings.Index(p, " -> "); i >= 0 {
			p = p[i+4:]
		}
		out = append(out, strings.Trim(p, `"`))
	}
	return out
}
