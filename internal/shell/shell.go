// Package shell runs a project command line on Unix (`sh -c`) and Windows (`cmd /C`).
package shell

import (
	"context"
	"os/exec"
	"runtime"
)

// Command returns a Cmd that runs cmdline through the platform shell.
func Command(ctx context.Context, cmdline string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.CommandContext(ctx, "cmd", "/C", cmdline)
	}
	return exec.CommandContext(ctx, "sh", "-c", cmdline)
}
