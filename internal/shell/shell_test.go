package shell

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCommandEcho(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := "echo wingman-shell"
	if runtime.GOOS == "windows" {
		cmd = "echo wingman-shell"
	}
	c := Command(ctx, cmd)
	SetGroup(c)
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("run: %v (%s)", err, out)
	}
	if !strings.Contains(string(out), "wingman-shell") {
		t.Fatalf("output %q", out)
	}
}
