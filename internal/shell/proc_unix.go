//go:build !windows

package shell

import (
	"os/exec"
	"syscall"
)

// SetGroup puts c in its own process group so KillGroup can stop the whole tree.
func SetGroup(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// KillGroup sends SIGKILL to the process group of c.
func KillGroup(c *exec.Cmd) {
	if c.Process == nil {
		return
	}
	if err := syscall.Kill(-c.Process.Pid, syscall.SIGKILL); err != nil {
		_ = c.Process.Kill()
	}
}
