//go:build !windows

package runstate

import (
	"errors"
	"syscall"
)

// pidAlive reports whether a process with this id runs on this host (signal 0 probes without sending).
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
