//go:build unix

package timeline

import (
	"errors"
	"os"
	"syscall"
)

// lockFile blocks until this process holds the exclusive flock on f.
func lockFile(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

func unlockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
