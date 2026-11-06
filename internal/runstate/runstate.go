// Package runstate is who owns an apply run and what a verification record was made from.
//
//   - Each run records its owner (run.json: session, pid, host, code worktree, branch, HEAD, tree hash, start, last activity).
//   - A lock (lock.json: pid, host, session, command, heartbeat) refuses a second command on the same change while one runs;
//     --takeover replaces it.
//   - A passing check records HEAD and the hash of the task's Files:; a record whose commit is not in this checkout's history and
//     whose files differ is foreign: it never counts as verified here.
package runstate

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Spreizu/wingman-spec/internal/gitx"
)

// Timing constants.
const (
	IdleMin       = 30 // a run idle longer than this many minutes is taken over without --takeover
	heartbeat     = 15 * time.Second
	lockStaleTime = 2 * time.Minute
)

// ISO is the timestamp format of every record (UTC, milliseconds), as v1 wrote it.
const ISO = "2006-01-02T15:04:05.000Z07:00"

// Now is the current time as an ISO string in UTC.
func Now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func parseISO(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

// ReadJSON reads a JSON file into v; false when it is missing or broken.
func ReadJSON(f string, v any) bool {
	b, err := os.ReadFile(f)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

// WriteJSON writes v indented with a trailing newline.
func WriteJSON(f string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f, append(b, '\n'), 0o644)
}

// ---------- timing ----------

type step struct {
	name string
	secs float64
}

var (
	stepsMu sync.Mutex
	steps   []step
)

// Timed runs fn and records how long it took under name.
func Timed[T any](name string, fn func() T) T {
	t0 := time.Now()
	v := fn()
	stepsMu.Lock()
	steps = append(steps, step{name, time.Since(t0).Seconds()})
	stepsMu.Unlock()
	return v
}

// Step is one entry of Profile.
type Step struct {
	Step    string  `json:"step"`
	Seconds float64 `json:"seconds"`
	N       int     `json:"n"`
}

// Profile sums the recorded steps per name, most expensive first.
func Profile() []Step {
	stepsMu.Lock()
	defer stepsMu.Unlock()
	m := map[string]*Step{}
	var order []string
	for _, s := range steps {
		e, ok := m[s.name]
		if !ok {
			e = &Step{Step: s.name}
			m[s.name] = e
			order = append(order, s.name)
		}
		e.Seconds += s.secs
		e.N++
	}
	out := make([]Step, 0, len(order))
	for _, k := range order {
		e := *m[k]
		e.Seconds = float64(int(e.Seconds*100+0.5)) / 100
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Seconds > out[j].Seconds })
	return out
}

// ---------- file lists and reads ----------

// RepoFiles is one `git ls-files -z -co --exclude-standard` (tracked and untracked, ignored left out).
type RepoFiles struct {
	All, Tracked, Untracked []string
	OK                      bool
}

type repoFiles struct {
	index string
	list  RepoFiles
}

var (
	filesMu   sync.Mutex
	fileCache = map[string]repoFiles{}
	readMu    sync.Mutex
	reads     = map[string]struct {
		size, mtime int64
		text        string
	}{}
	busts = map[string]uint64{}
)

func indexStat(dir string) string {
	st, err := os.Stat(filepath.Join(dir, ".git", "index"))
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d", st.Size(), st.ModTime().UnixNano())
}

// Files is the tracked and untracked files of dir, taken once until the git index changes or ForgetTrees runs.
// The slices must not be modified.
func Files(dir string) RepoFiles {
	id := indexStat(dir)
	filesMu.Lock()
	if c, ok := fileCache[dir]; ok && id != "" && c.index == id {
		filesMu.Unlock()
		return c.list
	}
	filesMu.Unlock()
	recs, ok := gitx.Z(dir, nil, "-c", "core.quotepath=off", "ls-files", "-z", "-t", "-co", "--exclude-standard")
	if !ok {
		return RepoFiles{}
	}
	list := RepoFiles{OK: true}
	for _, rec := range recs {
		if len(rec) < 2 || rec[1] != ' ' {
			list.All = append(list.All, rec)
			continue
		}
		path := rec[2:]
		list.All = append(list.All, path)
		if rec[0] == '?' {
			list.Untracked = append(list.Untracked, path)
		} else {
			list.Tracked = append(list.Tracked, path)
		}
	}
	if id != "" {
		filesMu.Lock()
		fileCache[dir] = repoFiles{index: id, list: list}
		filesMu.Unlock()
	}
	return list
}

// Ignored is the tracked files a .gitignore matches (`git ls-files -ci`), memoised with Files.
func Ignored(dir string) map[string]bool {
	id := indexStat(dir)
	filesMu.Lock()
	if c, ok := fileCache[dir+"\x00ignored"]; ok && id != "" && c.index == id {
		filesMu.Unlock()
		out := map[string]bool{}
		for _, f := range c.list.All {
			out[f] = true
		}
		return out
	}
	filesMu.Unlock()
	xs, ok := gitx.Z(dir, nil, "-c", "core.quotepath=off", "ls-files", "-z", "-ci", "--exclude-standard")
	if !ok {
		return map[string]bool{}
	}
	if id != "" {
		filesMu.Lock()
		fileCache[dir+"\x00ignored"] = repoFiles{index: id, list: RepoFiles{All: xs, OK: true}}
		filesMu.Unlock()
	}
	out := map[string]bool{}
	for _, f := range xs {
		out[f] = true
	}
	return out
}

// ReadCached reads path once per size and mtime. The bool is false when the file is missing.
func ReadCached(path string) (string, bool) {
	st, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	readMu.Lock()
	if c, ok := reads[path]; ok && c.size == st.Size() && c.mtime == st.ModTime().UnixNano() {
		readMu.Unlock()
		return c.text, true
	}
	readMu.Unlock()
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	text := string(b)
	readMu.Lock()
	reads[path] = struct {
		size, mtime int64
		text        string
	}{st.Size(), st.ModTime().UnixNano(), text}
	readMu.Unlock()
	return text, true
}

// ForgetRead drops one cached file so the next read sees a rewrite in the same second.
func ForgetRead(path string) {
	readMu.Lock()
	delete(reads, path)
	busts[path]++
	readMu.Unlock()
}

// Bust is how many times path was dropped. A parser cache stores it next to the mtime.
func Bust(path string) uint64 {
	readMu.Lock()
	defer readMu.Unlock()
	return busts[path]
}

// ---------- working-tree hashes ----------

type blob struct{ mode, path, oid string }

// snap is one write-tree of the tracked files. Filters are applied to blobs in Go.
type snap struct {
	tree, stamp, index string
	blobs              []blob
}

var (
	treesMu sync.Mutex
	trees   = map[string]string{}
	tracked = map[string]*snap{}
)

// ForgetTrees drops the memoised tree hashes and file lists (a command may have edited files).
func ForgetTrees() {
	treesMu.Lock()
	trees = map[string]string{}
	tracked = map[string]*snap{}
	treesMu.Unlock()
	filesMu.Lock()
	fileCache = map[string]repoFiles{}
	filesMu.Unlock()
	gitx.ForgetHead()
}

// NotCode is run state and the plan's ticks: they change between check and finish without touching code.
var NotCode = regexp.MustCompile(NotBase.String() + `|(^|/)\.wingman-spec/(runs|bin|cache|local)/|(^|/)changes/[^/]+/(tasks|progress)\.md$`)

// NotBase is the merge base the CLI pins on a change's first lint (changes/<change>/spec-base.json): derived state that
// no fingerprint counts.
var NotBase = regexp.MustCompile(`(^|/)changes/[^/]+/spec-base\.json$`)

// NotGate is NotCode plus what sync and lint write after finish (the living specs, ADRs, archived changes and a
// change's spec-base.json): the archive gate compares the rest with what finish saw.
var NotGate = regexp.MustCompile(NotCode.String() + `|(^|/)\.wingman-spec/(specs|adrs|archive)/`)

// GateTree is the working-tree hash the archive gate compares with the one finish recorded ("" outside git). It is a
// real tree object: untracked files are hashed by content (WorkTree uses stat data), so committing after finish keeps
// the same hash, and a later process can diff it. Tracked files the project's .gitignore matches (a committed runtime
// log the app appends to) are left out: they are not code.
func GateTree(dir string) string {
	return indexTree(dir, NotGate, true, "add", "-A")
}

// GateChanges lists the paths that differ between two GateTree hashes (nil when either tree is gone).
func GateChanges(dir, was, now string) []string {
	xs, _ := gitx.Z(dir, nil, "diff-tree", "-r", "-z", "--name-only", was, now)
	return xs
}

// NotApp is NotCode plus tests and Markdown: what the pages are not built from (the visual cache key).
var NotApp = regexp.MustCompile(NotCode.String() + `|(^|/)(tests?|__tests__|e2e|spec)/|\.(test|spec)\.[^/]+$|\.mdx?$`)

// WorkTree is the hash of the whole working tree (tracked and untracked, not ignored); drop removes matching paths first.
// It equals HEAD's tree right after a commit when nothing is untracked. "" outside git.
func WorkTree(dir string, drop *regexp.Regexp) string {
	k := dir + "\x00"
	if drop != nil {
		k += drop.String()
	}
	treesMu.Lock()
	v, ok := trees[k]
	treesMu.Unlock()
	if ok {
		return v
	}
	v = workTree(dir, drop)
	treesMu.Lock()
	trees[k] = v
	treesMu.Unlock()
	return v
}

func workTree(dir string, drop *regexp.Regexp) string {
	s := ensureSnap(dir)
	if s == nil || s.tree == "" {
		return ""
	}
	kept := s.blobs
	if drop != nil {
		kept = slices.DeleteFunc(append([]blob{}, s.blobs...), func(b blob) bool { return drop.MatchString(b.path) })
	}
	tree := s.tree
	if len(kept) != len(s.blobs) {
		tree = hashBlobs(kept)
	}
	lf := Files(dir)
	if !lf.OK {
		return ""
	}
	extra := append([]string{}, lf.Untracked...)
	extra = slices.DeleteFunc(extra, func(f string) bool { return drop != nil && drop.MatchString(f) })
	if len(extra) == 0 {
		return tree
	}
	slices.Sort(extra)
	h := sha1.New()
	for _, f := range extra {
		st, err := os.Stat(filepath.Join(dir, f))
		if err != nil {
			fmt.Fprintf(h, "%s\x00-\x00", f)
			continue
		}
		fmt.Fprintf(h, "%s\x00%d:%d\x00", f, st.Size(), st.ModTime().UnixNano())
	}
	return tree + "+" + hex.EncodeToString(h.Sum(nil))
}

func ensureSnap(dir string) *snap {
	lf := Files(dir)
	if !lf.OK {
		return nil
	}
	stamp := fileStamp(dir, lf.Tracked)
	id := indexStat(dir)
	treesMu.Lock()
	if s := tracked[dir]; s != nil && s.stamp == stamp && s.index == id {
		treesMu.Unlock()
		return s
	}
	treesMu.Unlock()
	tree := Timed("git: working-tree hash", func() string { return indexTree(dir, nil, false, "add", "-u") })
	if tree == "" {
		return nil
	}
	s := &snap{tree: tree, blobs: lsTree(dir, tree), stamp: stamp, index: id}
	treesMu.Lock()
	tracked[dir] = s
	treesMu.Unlock()
	return s
}

func fileStamp(dir string, paths []string) string {
	h := sha1.New()
	for _, f := range paths {
		st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f)))
		if err != nil {
			fmt.Fprintf(h, "%s\x00-\n", f)
			continue
		}
		fmt.Fprintf(h, "%s\x00%d:%d\n", f, st.Size(), st.ModTime().UnixNano())
	}
	return hex.EncodeToString(h.Sum(nil))
}

func hashBlobs(blobs []blob) string {
	h := sha1.New()
	for _, b := range blobs {
		fmt.Fprintf(h, "%s %s\x00%s\n", b.mode, b.path, b.oid)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func lsTree(dir, tree string) []blob {
	out, ok := gitx.RunRaw(dir, nil, nil, "ls-tree", "-r", "-z", tree)
	if !ok {
		return nil
	}
	var blobs []blob
	for rec := range strings.SplitSeq(out, "\x00") {
		if rec == "" {
			continue
		}
		metaPart, path, ok := strings.Cut(rec, "\t")
		if !ok {
			continue
		}
		meta := strings.Split(metaPart, " ")
		if len(meta) < 3 {
			continue
		}
		blobs = append(blobs, blob{meta[0], path, meta[2]})
	}
	return blobs
}

// IndexTree is the tree object of a temporary copy of the index after stage (`add -u` or `add -A`), drop paths removed.
// The real index, HEAD and the branch stay untouched.
func IndexTree(dir string, drop *regexp.Regexp, stage ...string) string {
	return indexTree(dir, drop, false, stage...)
}

func indexTree(dir string, drop *regexp.Regexp, dropIgnored bool, stage ...string) string {
	real, ok := gitx.Run(dir, nil, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if !ok {
		return ""
	}
	tmp, err := os.CreateTemp("", "wingman-index-*")
	if err != nil {
		return ""
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if b, err := os.ReadFile(real); err == nil {
		_, _ = tmp.Write(b)
	}
	_ = tmp.Close()
	if st, err := os.Stat(real); err != nil {
		_ = os.Remove(name) // git wants no file rather than an empty one
	} else {
		// Keep the index mtime: git's racy-entry check compares it with each file's mtime, so a same-size edit in
		// the second of the last index write is rehashed rather than trusted from stat data.
		_ = os.Chtimes(name, st.ModTime(), st.ModTime())
	}
	env := []string{"GIT_INDEX_FILE=" + name}
	if _, ok := gitx.Run(dir, env, stage...); !ok {
		return ""
	}
	var gone []string
	if drop != nil {
		files, _ := gitx.Z(dir, env, "ls-files", "-z")
		gone = slices.DeleteFunc(files, func(f string) bool { return !drop.MatchString(f) })
	}
	if dropIgnored {
		files, _ := gitx.Z(dir, env, "ls-files", "-z", "-ci", "--exclude-standard")
		gone = append(gone, files...)
	}
	if len(gone) > 0 {
		gitx.RunRaw(dir, env, []byte(strings.Join(gone, "\x00")+"\x00"), "update-index", "--force-remove", "-z", "--stdin")
	}
	t, ok := gitx.Run(dir, env, "write-tree")
	if !ok {
		return ""
	}
	return t
}

// Fingerprint is HEAD, the branch and (optionally) the working-tree hashes.
type Fingerprint struct {
	Head   string `json:"head"`
	Branch string `json:"branch"`
	Tree   string `json:"tree,omitempty"`
	Gate   string `json:"gate,omitempty"` // GateTree: stable across a same-content commit
}

// Fingerprinted returns the fingerprint of dir.
func Fingerprinted(dir string, withTree bool) Fingerprint {
	head := gitx.Head(dir)
	if head == "" {
		return Fingerprint{}
	}
	b, _ := gitx.Run(dir, nil, "rev-parse", "--abbrev-ref", "HEAD")
	fp := Fingerprint{Head: head, Branch: b}
	if withTree {
		fp.Tree = WorkTree(dir, NotBase)
		fp.Gate = GateTree(dir)
	}
	return fp
}

// CacheTree is the hash that keys the result cache (run state and plan ticks left out).
func CacheTree(dir string) string { return WorkTree(dir, NotCode) }

// AppTree is CacheTree without tests and Markdown.
func AppTree(dir string) string { return WorkTree(dir, NotApp) }

// CacheFile is the cache file of this tree, directory and command ("" when tree is "").
func CacheFile(runsDir, cwd, cmd, tree string) string {
	if tree == "" {
		return ""
	}
	s := sha1.Sum([]byte(tree + "\x00" + cwd + "\x00" + cmd))
	return filepath.Join(runsDir, "cache", hex.EncodeToString(s[:])+".json")
}

// FilesHash is the content hash of the files a task lists (Files:); "" when it lists none or git fails.
func FilesHash(dir string, entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	names, ok := gitx.Z(dir, nil, append([]string{"ls-files", "-co", "--exclude-standard", "-z", "--"}, entries...)...)
	if !ok {
		return ""
	}
	slices.Sort(names)
	h := sha1.New()
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			b = []byte("deleted")
		}
		h.Write([]byte(n + "\x00"))
		h.Write(b)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ---------- identity and ownership ----------

// Identity is who this process is.
type Identity struct {
	Session  string `json:"session"`
	PID      int    `json:"pid"`
	Host     string `json:"host"`
	Worktree string `json:"worktree"`
}

// Me is this process's identity; session is --session or WINGMAN_SPEC_SESSION.
func Me(session, codeRoot string) Identity {
	if session == "" {
		session = os.Getenv("WINGMAN_SPEC_SESSION")
	}
	h, _ := os.Hostname()
	return Identity{session, os.Getpid(), h, codeRoot}
}

// Run is run.json.
type Run struct {
	ID           string `json:"id"`
	Session      string `json:"session"`
	PID          int    `json:"pid"`
	Host         string `json:"host"`
	Worktree     string `json:"worktree"`
	Started      string `json:"started"`
	LastActivity string `json:"last_activity"`
	Head         string `json:"head"`
	Branch       string `json:"branch"`
	Tree         string `json:"tree,omitempty"`
	TakenOverAt  string `json:"taken_over_at,omitempty"`
}

// Minutes since iso (0 when unparsable).
func Minutes(iso string, now time.Time) int {
	t, ok := parseISO(iso)
	if !ok {
		return 0
	}
	return max(0, int(now.Sub(t).Minutes()+0.5))
}

func short(h string) string {
	if h == "" {
		return "no commit"
	}
	return h[:min(8, len(h))]
}

// Ownership says whether a run is another session's or worktree's, and how long it is idle.
type Ownership struct {
	Foreign, OtherSession, OtherTree, Unknown bool
	Idle                                      int
}

// Owner judges rec for me.
func Owner(rec *Run, me Identity, now time.Time) Ownership {
	last := rec.LastActivity
	if last == "" {
		last = rec.Started
	}
	o := Ownership{Idle: Minutes(last, now)}
	o.OtherSession = rec.Session != "" && me.Session != "" && rec.Session != me.Session
	o.OtherTree = rec.Worktree != "" && rec.Worktree != me.Worktree
	o.Foreign = o.OtherSession || o.OtherTree
	o.Unknown = rec.Session == "" || me.Session == ""
	return o
}

// Describe is a run in one line; fresh (the run this command just started) leaves out the start time and idle minutes.
func Describe(rec *Run, now time.Time, fresh bool) string {
	b := rec.Branch
	if b == "" {
		b = "no branch"
	}
	s := rec.Session
	if s == "" {
		s = "unknown"
	}
	where := fmt.Sprintf("%s at %s in %s", b, short(rec.Head), rec.Worktree)
	if fresh {
		return fmt.Sprintf("run %s (session %s) on %s", rec.ID, s, where)
	}
	last := rec.LastActivity
	if last == "" {
		last = rec.Started
	}
	return fmt.Sprintf("run %s (session %s) started %s, %s; last command %d min ago", rec.ID, s, rec.Started, where, Minutes(last, now))
}

// ---------- lock ----------

// Holder is lock.json.
type Holder struct {
	PID       int    `json:"pid"`
	Host      string `json:"host"`
	Session   string `json:"session"`
	Command   string `json:"command"`
	Started   string `json:"started"`
	Heartbeat string `json:"heartbeat"`
}

func live(h *Holder, now time.Time) bool {
	t, ok := parseISO(h.Heartbeat)
	if !ok || now.Sub(t) > lockStaleTime {
		return false
	}
	if host, _ := os.Hostname(); h.Host != host {
		return true
	}
	if h.PID <= 0 {
		return false
	}
	return pidAlive(h.PID)
}

// Lock is a held change lock; Release removes it.
type Lock struct {
	file string
	stop chan struct{}
	once sync.Once
}

// Acquire takes the change's lock for command; it returns the live holder when another command holds it.
func Acquire(dir string, me Identity, command string, takeover bool) (*Lock, *Holder, error) {
	f := filepath.Join(dir, "lock.json")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	mine := func() []byte {
		now := Now()
		b, _ := json.MarshalIndent(Holder{os.Getpid(), me.Host, me.Session, command, now, now}, "", "  ")
		return append(b, '\n')
	}
	for tries := range 3 {
		fh, err := os.OpenFile(f, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			_, werr := fh.Write(mine())
			cerr := fh.Close()
			if werr != nil || cerr != nil {
				return nil, nil, errors.Join(werr, cerr)
			}
			l := &Lock{file: f, stop: make(chan struct{})}
			go l.beat()
			return l, nil, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, nil, err
		}
		var h Holder
		okh := ReadJSON(f, &h)
		if okh && h.PID != os.Getpid() && live(&h, time.Now()) && !takeover {
			return nil, &h, nil
		}
		_ = os.Remove(f)
		if tries == 2 {
			return nil, &h, nil
		}
	}
	return nil, &Holder{}, nil
}

func (l *Lock) beat() {
	t := time.NewTicker(heartbeat)
	defer t.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-t.C:
			var h Holder
			if ReadJSON(l.file, &h) && h.PID == os.Getpid() {
				h.Heartbeat = Now()
				_ = WriteJSON(l.file, h)
			}
		}
	}
}

// Release stops the heartbeat and removes the lock if this process still holds it.
func (l *Lock) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		close(l.stop)
		var h Holder
		if ReadJSON(l.file, &h) && h.PID == os.Getpid() {
			_ = os.Remove(l.file)
		}
	})
}

// ---------- verification records ----------

// Record is one passing check in verified.json (or finished.json).
type Record struct {
	At        string `json:"at"`
	Run       string `json:"run"`
	Session   string `json:"session"`
	Head      string `json:"head"`
	Branch    string `json:"branch"`
	Tree      string `json:"tree,omitempty"`
	Gate      string `json:"gate,omitempty"` // GateTree when finish passed (finished.json)
	Worktree  string `json:"worktree"`
	FilesHash string `json:"files_hash,omitempty"`
	Affected  bool   `json:"affected,omitempty"` // finish --affected: not enough for the archive gate
}

// Judge says whether a record is still good here: valid, or foreign (another branch or checkout).
func Judge(dir string, rec *Record, now Fingerprint, filesHash string) (string, string) {
	if rec == nil || rec.Head == "" {
		return "valid", "no commit recorded (git not used)"
	}
	br := rec.Branch
	if br == "" {
		br = "?"
	}
	if now.Head != "" && gitx.IsAncestor(dir, rec.Head, now.Head) {
		return "valid", fmt.Sprintf("recorded at %s, in this history", short(rec.Head))
	}
	if rec.FilesHash != "" && filesHash == rec.FilesHash {
		return "valid", fmt.Sprintf("recorded at %s on %s; the task's files are identical here", short(rec.Head), br)
	}
	if rec.FilesHash == "" && now.Tree != "" && now.Tree == rec.Tree {
		return "valid", fmt.Sprintf("recorded at %s on %s; the tree is identical here", short(rec.Head), br)
	}
	wt := rec.Worktree
	if wt == "" {
		wt = "?"
	}
	what := "tree differs"
	if rec.FilesHash != "" {
		what = "task's files differ"
	}
	return "foreign", fmt.Sprintf("recorded at %s on %s in %s by run %s: that commit is not part of this checkout's history and the %s", short(rec.Head), br, wt, rec.Run, what)
}

// FinishLine says whether the last finish still holds.
// Prefer Gate (content tree, stable when the user commits the same files) over Tree (WorkTree, which
// changes shape when untracked files become tracked).
func FinishLine(f *Record, fp Fingerprint) string {
	if f == nil {
		return "finish has not passed yet: run finish"
	}
	br := f.Branch
	if br == "" {
		br = "?"
	}
	tail := "the working tree has changed since (STALE): run finish again"
	holds := f.Gate != "" && fp.Gate != "" && f.Gate == fp.Gate
	if !holds {
		holds = f.Tree != "" && f.Tree == fp.Tree
	}
	if holds {
		tail = "the working tree is unchanged since, so that result still holds"
	}
	return fmt.Sprintf("finish passed %s at %s on %s by run %s: %s", f.At, short(f.Head), br, f.Run, tail)
}

// Ledger is verified.json: tasks ticked before the verifier first ran, and the tasks a check passed.
type Ledger struct {
	Baseline []string           `json:"baseline"`
	Passed   map[string]*Record `json:"passed"`
}

// Verified reports whether a task description is in the ledger.
func (l *Ledger) Verified(d string) bool {
	_, ok := l.Passed[d]
	return ok || slices.Contains(l.Baseline, d)
}

// Summary is one line for "everything is ticked": what was verified, by which run, at which commit, still valid or not.
func Summary(l *Ledger, finished *Record, fp Fingerprint, total int) string {
	parts := []string{fmt.Sprintf("%d of %d tasks are ticked and verified", total, total)}
	var lastK string
	var last *Record
	var lastT time.Time
	for k, v := range l.Passed {
		t, _ := parseISO(v.At)
		if last == nil || t.After(lastT) || (t.Equal(lastT) && k > lastK) {
			lastK, last, lastT = k, v, t
		}
	}
	if last != nil {
		br := last.Branch
		if br == "" {
			br = "?"
		}
		sess := ""
		if last.Session != "" {
			sess = " (session " + last.Session + ")"
		}
		same := "different from"
		if last.Tree != "" && last.Tree == fp.Tree {
			same = "unchanged since"
		}
		parts = append(parts, fmt.Sprintf(`last task check: "%s" passed %s at %s on %s by run %s%s; the working tree is %s that check`, lastK, last.At, short(last.Head), br, last.Run, sess, same))
	} else {
		parts = append(parts, "no task check is recorded (the ticks were there before the verifier first ran)")
	}
	parts = append(parts, FinishLine(finished, fp))
	return strings.Join(parts, ". ")
}

// Range is the code-review range: the change's base commit and a snapshot commit of the working tree.
type Range struct {
	Base string `json:"base"`
	Head string `json:"head"`
}

// ReviewRange builds an unreferenced commit of the working tree (tracked, untracked, not ignored; run state left out),
// parented on base (or HEAD). The user's index, branch, HEAD and log stay untouched. nil without git.
func ReviewRange(dir, base string) *Range {
	head := gitx.Head(dir)
	if head == "" {
		return nil
	}
	from := head
	if base != "" {
		if _, ok := gitx.Run(dir, nil, "cat-file", "-e", base+"^{commit}"); ok {
			from = base
		}
	}
	tree := Timed("git: review snapshot", func() string { return IndexTree(dir, NotCode, "add", "-A") })
	if tree == "" {
		return nil
	}
	when := "1970-01-01T00:00:00Z"
	env := []string{"GIT_AUTHOR_DATE=" + when, "GIT_COMMITTER_DATE=" + when}
	email, _ := gitx.Run(dir, nil, "config", "user.email")
	name, _ := gitx.Run(dir, nil, "config", "user.name")
	if email == "" || name == "" {
		env = append(env, "GIT_AUTHOR_NAME=wingman-spec", "GIT_AUTHOR_EMAIL=wingman-spec@localhost", "GIT_COMMITTER_NAME=wingman-spec", "GIT_COMMITTER_EMAIL=wingman-spec@localhost")
	}
	snap, ok := gitx.Run(dir, env, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", from, "-m", "working tree snapshot for review")
	if !ok || snap == "" {
		return nil
	}
	return &Range{from, snap}
}
