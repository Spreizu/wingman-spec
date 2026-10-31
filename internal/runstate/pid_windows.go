//go:build windows

package runstate

import "os"

// pidAlive reports whether a process with this id runs on this host (FindProcess opens a handle on Windows).
func pidAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p.Release()
	return true
}
