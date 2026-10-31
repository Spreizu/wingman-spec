//go:build windows

package verify

import "os/exec"

func setGroup(*exec.Cmd) {}

func killGroup(c *exec.Cmd) {
	if c.Process != nil {
		_ = c.Process.Kill()
	}
}
