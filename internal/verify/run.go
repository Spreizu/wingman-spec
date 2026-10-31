package verify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Spreizu/wingman-spec/internal/runstate"
)

const (
	tailMax = 4000
	fullMax = 4 * 1024 * 1024
)

// Result is one finished command.
type Result struct {
	Cmd      string  `json:"cmd"`
	Limit    int     `json:"limit,omitempty"`
	RC       int     `json:"rc"`
	TimedOut bool    `json:"timed_out,omitempty"`
	Seconds  float64 `json:"seconds"`
	Tail     string  `json:"tail"`
	Full     string  `json:"full,omitempty"`
	Cached   bool    `json:"cached,omitempty"`
}

// capture keeps the tail and the first 4 MB of a command's output.
type capture struct {
	mu   sync.Mutex
	tail []byte
	full bytes.Buffer
}

func (c *capture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tail = append(c.tail, p...)
	if len(c.tail) > 4*tailMax {
		c.tail = append([]byte{}, c.tail[len(c.tail)-2*tailMax:]...)
	}
	if room := fullMax - c.full.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		c.full.Write(p)
	}
	return len(p), nil
}

func (c *capture) last() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.tail
	if len(t) > tailMax {
		t = t[len(t)-tailMax:]
	}
	return string(t)
}

func short(cmd string) string {
	if len(cmd) > 90 {
		return cmd[:87] + "..."
	}
	return cmd
}

// runCmd runs cmd with `sh -c` in its own process group and kills the group at the limit (rc 124). With a label it
// says on stderr when the command is still running after 3 s and every 15 s after that, and when it ends.
func (e *Env) runCmd(cmd, dir string, limit int, label string) Result {
	runstate.ForgetTrees()
	t0 := time.Now()
	ctx, cancel := context.WithTimeout(e.Ctx, time.Duration(limit)*time.Second)
	defer cancel()
	c := exec.Command("sh", "-c", cmd)
	c.Dir = dir
	c.Env = os.Environ()
	setGroup(c)
	var out capture
	c.Stdout, c.Stderr = &out, &out
	if err := c.Start(); err != nil {
		return Result{Cmd: cmd, Limit: limit, RC: 127, Tail: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	secs := func() int { return int(time.Since(t0).Seconds() + 0.5) }
	beat := time.NewTimer(3 * time.Second)
	defer beat.Stop()
	timedOut := false
	var werr error
loop:
	for {
		select {
		case werr = <-done:
			break loop
		case <-beat.C:
			if label != "" {
				e.say("%s: still running after %ds (limit %ds): %s", label, secs(), limit, short(cmd))
			}
			beat.Reset(15 * time.Second)
		case <-ctx.Done():
			timedOut = true
			killGroup(c)
			werr = <-done
			break loop
		}
	}
	rc := 0
	if werr != nil {
		if ee, ok := errors.AsType[*exec.ExitError](werr); ok {
			rc = ee.ExitCode()
			if rc < 0 {
				rc = 128
			}
		} else {
			rc = 127
		}
	}
	if timedOut {
		rc = 124
	}
	if label != "" && (time.Since(t0) >= 3*time.Second || timedOut) {
		if timedOut {
			e.say("%s: killed after the %ds limit", label, limit)
		} else {
			e.say("%s: finished in %ds (exit %d)", label, secs(), rc)
		}
	}
	return Result{Cmd: cmd, Limit: limit, RC: rc, TimedOut: timedOut, Seconds: time.Since(t0).Seconds(), Tail: out.last(), Full: out.full.String()}
}

var posIntRE = regexp.MustCompile(`^[1-9][0-9]*$`)
var nonUpperRE = regexp.MustCompile(`[^A-Z]`)

// timeoutFor is --timeout, or WINGMAN_SPEC_TIMEOUT_<NAME> for one command.
func (e *Env) timeoutFor(name string) int {
	v := os.Getenv("WINGMAN_SPEC_TIMEOUT_" + nonUpperRE.ReplaceAllString(strings.ToUpper(name), "_"))
	if posIntRE.MatchString(v) {
		n, _ := strconv.Atoi(v)
		return n
	}
	return e.O.Timeout
}

func (e *Env) noCache() bool { return e.O.NoCache || os.Getenv("WINGMAN_SPEC_NO_CACHE") != "" }

// phaseTree is the tree hash that keys the result cache, taken before any command of this phase runs.
func (e *Env) phaseTree() string {
	if e.noCache() {
		return ""
	}
	return runstate.CacheTree(e.code)
}

var projectCmds = map[string]bool{"tests": true, "typecheck": true, "lint": true}

// runNamed runs one command, timed (safe to call concurrently; the caller drops the changed-files memo); a project command (tests, typecheck, lint) that passed on this tree is answered from the cache.
func (e *Env) runNamed(name, cmd, tree string) Result {
	r := runstate.Timed(name, func() Result {
		if !projectCmds[name] {
			return e.runCmd(cmd, e.code, e.timeoutFor(name), name)
		}
		f := ""
		if !e.noCache() {
			f = runstate.CacheFile(e.runsDir(), e.code, cmd, tree)
		}
		var hit Result
		if f != "" && runstate.ReadJSON(f, &hit) && hit.RC == 0 {
			hit.Seconds, hit.Cached = 0, true
			return hit
		}
		r := e.runCmd(cmd, e.code, e.timeoutFor(name), name)
		if f != "" && r.RC == 0 {
			_ = os.MkdirAll(dirOf(f), 0o755)
			_ = runstate.WriteJSON(f, Result{Cmd: cmd, Tail: r.Tail, Full: r.Full})
		}
		return r
	})
	return r
}

func dirOf(f string) string {
	if i := strings.LastIndexAny(f, `/\`); i >= 0 {
		return f[:i]
	}
	return "."
}

// failText is the failure line of a command result: `<name> failed (exit N): <cmd>`.
func failText(name string, r Result) string {
	if r.TimedOut {
		return fmt.Sprintf("%s failed (timed out after %ds): %s", name, r.Limit, r.Cmd)
	}
	return fmt.Sprintf("%s failed (exit %d): %s", name, r.RC, r.Cmd)
}
