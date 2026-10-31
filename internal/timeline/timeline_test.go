package timeline

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary act as one more writer process (TIMELINE_WRITER=<dir>).
func TestMain(m *testing.M) {
	if dir := os.Getenv("TIMELINE_WRITER"); dir != "" {
		for range 200 {
			Append(dir, Event{Event: "p", Summary: strings.Repeat("x", 300)})
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// Eight processes appending 200 events each leave 1600 whole lines.
func TestParallelAppends(t *testing.T) {
	dir := t.TempDir()
	cmds := make([]*exec.Cmd, 8)
	for i := range cmds {
		cmds[i] = exec.Command(os.Args[0], "-test.run=^$")
		cmds[i].Env = append(os.Environ(), "TIMELINE_WRITER="+dir)
		if err := cmds[i].Start(); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range cmds {
		if err := c.Wait(); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(dir, File)
	if n := len(Read(file)); n != 1600 {
		t.Errorf("read %d events, want 1600", n)
	}
	b, _ := os.ReadFile(file)
	if n := strings.Count(string(b), "\n"); n != 1600 {
		t.Errorf("%d lines, want 1600", n)
	}
	if c := Verify(file); c.Break != nil || c.Entries != 1600 {
		t.Errorf("parallel writers broke the hash chain: %+v", c)
	}
}

func TestAppendKeepsOrderAndText(t *testing.T) {
	dir := t.TempDir()
	ok := false
	Append(dir, Event{Event: "check", Task: "1.1", OK: &ok, Summary: "a <fill in> & b", Details: map[string]any{"failures": []string{"x"}, "empty": []string{}}})
	b, _ := os.ReadFile(filepath.Join(dir, File))
	line := string(b)
	for _, want := range []string{`"event":"check","task":"1.1","ok":false`, `a <fill in> & b`, `"details":{"failures":["x"]}`} {
		if !strings.Contains(line, want) {
			t.Errorf("missing %s in %s", want, line)
		}
	}
}

func TestIsoLocal(t *testing.T) {
	d := time.Date(2026, 10, 28, 14, 3, 22, 0, time.Local)
	if got := IsoLocal(d); !regexp.MustCompile(`^2026-10-28T14:03:22[+-]\d\d:\d\d$`).MatchString(got) {
		t.Errorf("IsoLocal = %s", got)
	}
}

// Read returns the events of a timeline file, oldest first (a torn line is skipped).
func Read(file string) []Event {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var out []Event
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		var e Event
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}
