// Package visual is the CLI side of the visual check. The browser work (Playwright, axe, screenshots) runs in the Node helper
// wingman-visual.cjs: Call writes one JSON job on its stdin and reads one JSON answer from its stdout. Everything that needs no
// browser and no helper (whether a change has visual scenarios, the config problem, which files are UI files) is here.
package visual

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/config"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
)

// HelperName is the file name of the Node helper in a source checkout (visual/).
const HelperName = "wingman-visual.cjs"

// ErrNoHelper means neither node nor the helper could be found.
var ErrNoHelper = errors.New("the visual helper needs Node.js (node on PATH)")

// Item is one scenario to check, with why it is checked: "task" (named by the task), "other" (a declared scenario of the
// change, checked for regressions) ; InScope when its component is in the task's Files:.
type Item struct {
	Scenario *Scenario `json:"scenario"`
	Role     string    `json:"role"`
	InScope  bool      `json:"inScope"`
	Shots    bool      `json:"shots,omitempty"`
}

var fence = regexp.MustCompile("(?m)^\\s*(```|~~~)\\s*visual\\b")

// HasBlocks reports whether any capability file in dir has a ```visual block (no helper needed to know).
func HasBlocks(dir string) bool {
	es, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range es {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err == nil && fence.Match(b) {
			return true
		}
	}
	return false
}

// ConfigProblem is why the visual check cannot run with this config ("" when it can, or when it is off).
func ConfigProblem(v config.Visual) string {
	if v.Off {
		return ""
	}
	if !v.Present {
		return "wingman-spec.yaml has no `visual:` section; add `visual:` with `command:` (starts the app) and `url:` (where it answers), or `visual: off` for a project without a UI"
	}
	var miss []string
	if v.Command == "" {
		miss = append(miss, "command")
	}
	if v.URL == "" && v.Port == 0 {
		miss = append(miss, "url")
	}
	switch len(miss) {
	case 0:
		return ""
	case 1:
		return fmt.Sprintf("visual.%s in wingman-spec.yaml is still a placeholder; set `%s:` (or `visual: off`)", miss[0], miss[0])
	default:
		return "visual.command and visual.url in wingman-spec.yaml are still a placeholder; set `command:` and `url:` (or `visual: off`)"
	}
}

// IsUIFile is a file whose change can alter what a visual scenario shows.
func IsUIFile(f string, v config.Visual) bool { return testpaths.IsUIFile(f, v.UIFiles...) }

// Helper finds node and the helper script: WINGMAN_VISUAL, the repository's visual/ folder next to the executable (a
// development build), else the helper embedded in the CLI, written to <code root>/.wingman-spec/bin on first use.
func Helper(codeRoot string) (node, script string, err error) {
	node, err = exec.LookPath("node")
	if err != nil {
		return "", "", ErrNoHelper
	}
	var cands []string
	if p := os.Getenv("WINGMAN_VISUAL"); p != "" {
		cands = append(cands, p)
	}
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
		d := filepath.Dir(exe)
		cands = append(cands, filepath.Join(d, "..", "visual", HelperName), filepath.Join(d, "..", "..", "visual", HelperName))
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return node, c, nil
		}
	}
	p, err := embeddedHelper(codeRoot)
	if err != nil {
		return "", "", ErrNoHelper
	}
	return node, p, nil
}

// Available reports whether the helper can run.
func Available(codeRoot string) bool { _, _, err := Helper(codeRoot); return err == nil }

type answer struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// Call runs one op. Progress the helper writes on stderr is copied to progress (when not nil).
func Call(ctx context.Context, codeRoot, op string, job map[string]any, out any, progress io.Writer) error {
	node, script, err := Helper(codeRoot)
	if err != nil {
		return err
	}
	j := map[string]any{"op": op}
	maps.Copy(j, job)
	in, err := json.Marshal(j)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, node, script)
	cmd.Stdin = bytes.NewReader(in)
	cmd.Env = os.Environ()
	var so bytes.Buffer
	cmd.Stdout = &so
	var tail bytes.Buffer
	pr, pw := io.Pipe()
	cmd.Stderr = pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			if progress != nil {
				fmt.Fprintln(progress, sc.Text())
			}
			if tail.Len() < 8000 {
				tail.WriteString(sc.Text() + "\n")
			}
		}
	}()
	runErr := cmd.Run()
	_ = pw.Close()
	<-done
	var a answer
	if err := json.Unmarshal(lastLine(so.Bytes()), &a); err != nil {
		if runErr != nil {
			return fmt.Errorf("visual helper (%s): %w: %s", op, runErr, strings.TrimSpace(tail.String()))
		}
		return fmt.Errorf("visual helper (%s): unreadable answer: %w", op, err)
	}
	if !a.OK {
		return errors.New(a.Error)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(a.Result, out)
}

func lastLine(b []byte) []byte {
	b = bytes.TrimSpace(b)
	if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
		return b[i+1:]
	}
	return b
}

// Scenarios parses the ```visual blocks of the capability files in dir (no helper: the grammar is parsed here).
func Scenarios(_ context.Context, _ string, dir string) ([]*Scenario, error) {
	if !HasBlocks(dir) {
		return nil, nil
	}
	return ParseScenarios(dir), nil
}
