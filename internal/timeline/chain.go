package timeline

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Genesis is the prev of the first chained entry.
var Genesis = strings.Repeat("0", 64)

// LineHash is the SHA-256 of one timeline line (without its line ending): the next entry's prev.
func LineHash(line []byte) string {
	h := sha256.Sum256(bytes.TrimRight(line, "\r\n"))
	return hex.EncodeToString(h[:])
}

// lastLine is the last non-empty line of f, or nil (read from the end: the file only grows).
func lastLine(f string) []byte {
	fh, err := os.Open(f)
	if err != nil {
		return nil
	}
	defer func() { _ = fh.Close() }()
	st, err := fh.Stat()
	if err != nil {
		return nil
	}
	for n := int64(64 << 10); ; n *= 2 {
		off := max(0, st.Size()-n)
		buf := make([]byte, st.Size()-off)
		if _, err := fh.ReadAt(buf, off); err != nil && !errors.Is(err, io.EOF) {
			return nil
		}
		buf = bytes.TrimRight(buf, "\r\n")
		if i := bytes.LastIndexByte(buf, '\n'); i >= 0 {
			return buf[i+1:]
		}
		if off == 0 {
			if len(buf) == 0 {
				return nil
			}
			return buf
		}
	}
}

// lock serialises the read-last-line-then-append of Append across processes (best effort: after 3 s it goes ahead).
func lock(dir string) func() {
	f := filepath.Join(dir, "timeline.lock")
	until := time.Now().Add(3 * time.Second)
	for {
		fh, err := os.OpenFile(f, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_ = fh.Close()
			return func() { _ = os.Remove(f) }
		}
		if !errors.Is(err, fs.ErrExist) || time.Now().After(until) {
			return func() {}
		}
		if st, e := os.Stat(f); e == nil && time.Since(st.ModTime()) > 10*time.Second {
			_ = os.Remove(f) // left by a killed process
			continue
		}
		time.Sleep(3 * time.Millisecond)
	}
}

// Break is the first entry where the hash chain does not hold.
type Break struct {
	Line   int    `json:"line"` // 1-based
	At     string `json:"at,omitempty"`
	Event  string `json:"event,omitempty"`
	Reason string `json:"reason"`
}

func (b *Break) String() string {
	who := fmt.Sprintf("entry %d", b.Line)
	if b.Event != "" {
		who += fmt.Sprintf(" (%s at %s)", b.Event, b.At)
	}
	return who + " " + b.Reason
}

// Chain is what Verify found: the entries, the head hash (of the last line) and the first break.
type Chain struct {
	Entries int    `json:"entries"`
	Head    string `json:"head,omitempty"`
	Break   *Break `json:"break,omitempty"`
}

// Verify checks the hash chain of a timeline file: each entry's prev is the hash of the line before it (the first
// one's is Genesis). Lines written before the chain existed (no prev, before any chained line) are accepted. An edited,
// deleted or reordered entry breaks the chain at the entry after it; an edit of the last entry, or a rewrite of the
// whole file, only shows against an anchored head (archived.json). A missing file is an empty chain.
func Verify(f string) Chain {
	b, err := os.ReadFile(f)
	if err != nil {
		return Chain{}
	}
	var c Chain
	var prev []byte
	chained := false
	for l := range bytes.SplitSeq(b, []byte("\n")) {
		l = bytes.TrimRight(l, "\r")
		if len(bytes.TrimSpace(l)) == 0 {
			continue
		}
		c.Entries++
		var ev struct{ At, Event, Prev string }
		bad := func(reason string) Chain {
			c.Break = &Break{Line: c.Entries, At: ev.At, Event: ev.Event, Reason: reason}
			return c
		}
		if json.Unmarshal(l, &ev) != nil {
			if chained {
				return bad("is not a valid entry")
			}
			prev = l
			continue
		}
		want := Genesis
		if prev != nil {
			want = LineHash(prev)
		}
		switch {
		case ev.Prev == "" && chained:
			return bad("has no link to the entry before it (an entry was inserted)")
		case ev.Prev != "" && ev.Prev != want:
			if c.Entries == 1 {
				return bad("does not start the chain (entries before it were deleted)")
			}
			return bad(fmt.Sprintf("does not follow entry %d (entry %d was edited, or entries were deleted or moved there)", c.Entries-1, c.Entries-1))
		case ev.Prev != "":
			chained = true
		}
		prev = l
	}
	if prev != nil {
		c.Head = LineHash(prev)
	}
	return c
}

// VerifyArchived is Verify of an archived change folder, also against the head anchored in archived.json.
func VerifyArchived(dir string) Chain {
	c := Verify(filepath.Join(dir, File))
	var a Archived
	b, err := os.ReadFile(filepath.Join(dir, "archived.json"))
	if c.Break != nil || err != nil || json.Unmarshal(b, &a) != nil || a.TimelineHead == "" {
		return c
	}
	if c.Head != a.TimelineHead || c.Entries != a.TimelineEntries {
		c.Break = &Break{Line: max(1, min(c.Entries, a.TimelineEntries)), Reason: fmt.Sprintf("does not match archived.json: it recorded %d entries ending in %.12s, the file has %d ending in %.12s (the last entries were edited or removed)", a.TimelineEntries, a.TimelineHead, c.Entries, c.Head)}
	}
	return c
}

// Anchor records the timeline's head hash and entry count in archived.json of an archived folder.
func Anchor(dir string) {
	f := filepath.Join(dir, "archived.json")
	var a Archived
	b, err := os.ReadFile(f)
	if err != nil || json.Unmarshal(b, &a) != nil {
		return
	}
	c := Verify(filepath.Join(dir, File))
	if c.Entries == 0 {
		return
	}
	a.TimelineHead, a.TimelineEntries = c.Head, c.Entries
	out, _ := json.MarshalIndent(a, "", "  ")
	_ = os.WriteFile(f, append(out, '\n'), 0o644)
}

// Problem is a calm one-line note about a broken chain in file f, or "".
func (c Chain) Problem(f string) string {
	if c.Break == nil {
		return ""
	}
	return fmt.Sprintf("%s: the timeline was changed after it was written: %s", f, c.Break)
}
