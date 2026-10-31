//go:build !unix && !windows

package timeline

import "os"

// lockFile is a no-op where neither flock nor LockFileEx exists.
func lockFile(*os.File) error   { return nil }
func unlockFile(*os.File) error { return nil }
