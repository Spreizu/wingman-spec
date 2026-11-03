//go:build windows

package shell

import (
	"os/exec"
	"strconv"
)

// SetGroup is a no-op on Windows: KillGroup uses taskkill /T on the process tree.
func SetGroup(*exec.Cmd) {}

// KillGroup stops c and every child it started (`taskkill /T /F`).
func KillGroup(c *exec.Cmd) {
	if c.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(c.Process.Pid))
	kill.SysProcAttr = hiddenWindow()
	if err := kill.Run(); err != nil {
		_ = c.Process.Kill()
	}
}
