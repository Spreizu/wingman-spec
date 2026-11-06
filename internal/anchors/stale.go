package anchors

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/Spreizu/wingman-spec/internal/gitx"
)

var (
	blameHead    = regexp.MustCompile(`^([0-9a-f]{40}) \d+ (\d+)`)
	headingLv23  = regexp.MustCompile(`^#{2,3}\s`)
	zeroSHA      = regexp.MustCompile(`^0+$`)
	blameDirs    sync.Map
	blameDirOnce sync.Mutex
)

type commit struct {
	SHA      string `json:"sha"`
	Time     int64  `json:"time"`
	Summary  string `json:"summary"`
	Boundary bool   `json:"boundary,omitempty"`
}

type blame struct {
	PerLine []string           `json:"perLine"`
	Info    map[string]*commit `json:"info"`
}

// blameCacheDir keeps blames in the repository's git directory, emptied when HEAD moves: a blame depends only on HEAD
// and the file's content. Nothing in the working tree changes.
func blameCacheDir(cwd string) string {
	blameDirOnce.Lock()
	defer blameDirOnce.Unlock()
	if d, ok := blameDirs.Load(cwd); ok {
		return d.(string)
	}
	dir := ""
	gd, ok1 := gitx.Run(cwd, nil, "rev-parse", "--absolute-git-dir")
	head := gitx.Head(cwd)
	if ok1 && gd != "" && head != "" {
		dir = filepath.Join(gd, "wingman-blame-cache")
		hf := filepath.Join(dir, "HEAD")
		if b, err := os.ReadFile(hf); err != nil || string(b) != head {
			_ = os.RemoveAll(dir)
			if os.MkdirAll(dir, 0o755) != nil || os.WriteFile(hf, []byte(head), 0o644) != nil {
				dir = ""
			}
		}
	}
	blameDirs.Store(cwd, dir)
	return dir
}

func blameOf(cwd, file string, copies bool) *blame {
	var cache string
	if os.Getenv("WINGMAN_SPEC_NO_CACHE") == "" {
		if dir := blameCacheDir(cwd); dir != "" {
			if content, err := os.ReadFile(filepath.Join(cwd, file)); err == nil {
				h := sha1.New()
				h.Write([]byte(file + "\x00" + strconv.FormatBool(copies) + "\x00"))
				h.Write(content)
				cache = filepath.Join(dir, hex.EncodeToString(h.Sum(nil))+".json")
			}
		}
	}
	if cache != "" {
		if b, err := os.ReadFile(cache); err == nil {
			var hit blame
			if json.Unmarshal(b, &hit) == nil && hit.Info != nil {
				return &hit
			}
		}
	}
	args := []string{"blame", "-w", "-M"}
	if copies {
		args = append(args, "-C", "-C")
	}
	out, ok := gitx.RunRaw(cwd, nil, nil, append(args, "--porcelain", "--", file)...)
	if !ok {
		return nil
	}
	r := &blame{Info: map[string]*commit{}}
	var cur string
	for l := range strings.SplitSeq(out, "\n") {
		if m := blameHead.FindStringSubmatch(l); m != nil {
			cur = m[1]
			n, _ := strconv.Atoi(m[2])
			for len(r.PerLine) < n {
				r.PerLine = append(r.PerLine, "")
			}
			r.PerLine[n-1] = cur
			if r.Info[cur] == nil {
				r.Info[cur] = &commit{SHA: cur}
			}
			continue
		}
		if cur == "" || strings.HasPrefix(l, "\t") {
			continue
		}
		switch {
		case strings.HasPrefix(l, "committer-time "):
			r.Info[cur].Time, _ = strconv.ParseInt(strings.TrimPrefix(l, "committer-time "), 10, 64)
		case strings.HasPrefix(l, "summary "):
			r.Info[cur].Summary = strings.TrimPrefix(l, "summary ")
		case l == "boundary":
			r.Info[cur].Boundary = true
		}
	}
	if cache != "" {
		if b, err := json.Marshal(r); err == nil {
			_ = os.WriteFile(cache, b, 0o644)
		}
	}
	return r
}

// blameAll runs the blames of files (key -> repository path) a few git processes at a time; each result is what
// blameOf gives for that file alone.
func blameAll(cwd string, files map[string]string, copies bool) map[string]*blame {
	out := make(map[string]*blame, len(files))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, min(8, max(2, runtime.NumCPU())))
	for k, f := range files {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			b := blameOf(cwd, f, copies)
			mu.Lock()
			out[k] = b
			mu.Unlock()
			<-sem
		}()
	}
	wg.Wait()
	return out
}

// specRange is the 1-based line range of the requirement that starts at line: until the next ##/### heading.
func specRange(text string, line int) (int, int) {
	lines := strings.Split(text, "\n")
	end := line
	for i := line; i < len(lines); i++ {
		if headingLv23.MatchString(lines[i]) {
			break
		}
		end = i + 1
	}
	return line, end
}

// StaleReq is what Stale needs of a requirement.
type StaleReq struct {
	Cap  string
	File string // absolute path of the living spec
	Line int
}

// StaleOpts are the inputs of Stale.
type StaleOpts struct {
	SpecsRoot string // a directory inside the repository of the living specs
	CodeRoot  string
	Reqs      map[string]StaleReq
	Markers   []Marker
	// SpecPath reports whether a repository path (relative to the code repository's top) is a spec file of capability cap:
	// a commit that touched one rewrote the requirement too, so it does not make the anchored code stale.
	SpecPath func(path, cap string) bool
}

// StaleAnchor is anchored code changed in a commit later than its requirement's text.
type StaleAnchor struct {
	Key, File          string
	Line               int
	Header             string
	Commit, Subject    string
	SpecCommit, SpecSj string
}

func isRepo(dir string) bool { _, ok := gitx.Run(dir, nil, "rev-parse", "--git-dir"); return ok }
func shallow(dir string) bool {
	s, _ := gitx.Run(dir, nil, "rev-parse", "--is-shallow-repository")
	return s == "true"
}

// Stale lists units whose code changed in a commit later than the last commit that touched their requirement's text.
func Stale(o StaleOpts) ([]StaleAnchor, []string) {
	if !isRepo(o.CodeRoot) {
		return nil, []string{"stale-anchor skipped: the code repository has no git history"}
	}
	if shallow(o.CodeRoot) {
		return nil, []string{"stale-anchor skipped: shallow clone (history is cut off; run `git fetch --unshallow`)"}
	}
	specTop := ""
	if isRepo(o.SpecsRoot) {
		specTop, _ = gitx.Run(o.SpecsRoot, nil, "rev-parse", "--show-toplevel")
	}
	if specTop == "" {
		return nil, []string{"stale-anchor skipped: the specs have no git history (specs outside a repository)"}
	}
	if shallow(o.SpecsRoot) {
		return nil, []string{"stale-anchor skipped: shallow clone of the specs repository"}
	}
	codeTop, _ := gitx.Run(o.CodeRoot, nil, "rev-parse", "--show-toplevel")
	rs, _ := filepath.EvalSymlinks(specTop)
	rc, _ := filepath.EvalSymlinks(codeTop)
	same := rs == rc
	var use []Marker
	for _, m := range o.Markers {
		if _, ok := o.Reqs[m.Key]; ok && !m.Test && !IsGenerated(m.File, "") {
			use = append(use, m)
		}
	}
	specFiles := map[string]string{}
	j := &staleJob{o: o, specTop: specTop, rs: rs, same: same, use: use,
		touched: map[string]bool{}, filesOf: map[string][]string{}, anc: map[string]bool{}}
	for _, m := range use {
		specFiles[o.Reqs[m.Key].File] = j.specRel(o.Reqs[m.Key].File)
	}
	j.specBlame = blameAll(specTop, specFiles, false)
	return j.anchors(), nil
}

type specC struct {
	c           *commit
	uncommitted bool
}

type staleJob struct {
	o         StaleOpts
	specTop   string
	rs        string
	same      bool
	use       []Marker
	specBlame map[string]*blame
	touched   map[string]bool
	filesOf   map[string][]string
	anc       map[string]bool
}

func (j *staleJob) specRel(file string) string {
	real, err := filepath.EvalSymlinks(file)
	if err != nil {
		real = file
	}
	rel, _ := filepath.Rel(j.rs, real)
	return filepath.ToSlash(rel)
}

func (j *staleJob) isAnc(a, b, cwd string) bool {
	if cwd == "" {
		cwd = j.o.CodeRoot
	}
	k := a + "|" + b + "|" + cwd
	v, ok := j.anc[k]
	if !ok {
		v = gitx.IsAncestor(cwd, a, b)
		j.anc[k] = v
	}
	return v
}

func (j *staleJob) newer(c, best *commit, cwd string) bool {
	return best == nil || c.Time > best.Time || (c.Time == best.Time && j.isAnc(best.SHA, c.SHA, cwd))
}

func (j *staleJob) specCommit(r StaleReq) specC {
	b, ok := j.specBlame[r.File]
	if !ok {
		b = blameOf(j.specTop, j.specRel(r.File), false)
		j.specBlame[r.File] = b
	}
	if b == nil {
		return specC{}
	}
	text, err := os.ReadFile(r.File)
	if err != nil {
		return specC{}
	}
	a, z := specRange(string(text), r.Line)
	var best *commit
	for i := a - 1; i < z && i < len(b.PerLine); i++ {
		sha := b.PerLine[i]
		if sha == "" {
			continue
		}
		if zeroSHA.MatchString(sha) {
			return specC{uncommitted: true}
		}
		if c := b.Info[sha]; c != nil && j.newer(c, best, j.specTop) {
			best = c
		}
	}
	return specC{c: best}
}

func (j *staleJob) touchesSpec(sha, cap string) bool {
	k := sha + "|" + cap
	if v, ok := j.touched[k]; ok {
		return v
	}
	names, ok := j.filesOf[sha]
	if !ok {
		out, _ := gitx.RunRaw(j.o.CodeRoot, nil, nil, "diff-tree", "-r", "--name-only", "--no-commit-id", "--root", sha)
		names = strings.Split(out, "\n")
		j.filesOf[sha] = names
	}
	hit := false
	for _, n := range names {
		if n != "" && j.o.SpecPath != nil && j.o.SpecPath(n, cap) {
			hit = true
			break
		}
	}
	j.touched[k] = hit
	return hit
}

func (j *staleJob) anchors() []StaleAnchor {
	var stale []StaleAnchor
	codeFiles := map[string]string{}
	for _, m := range j.use {
		if sc := j.specCommit(j.o.Reqs[m.Key]); sc.c != nil && !sc.uncommitted {
			codeFiles[m.File] = m.File
		}
	}
	fileBlame := blameAll(j.o.CodeRoot, codeFiles, true)
	seen := map[string]bool{}
	texts := map[string]string{}
	units := map[string]map[int][]Unit{}
	for _, m := range j.use {
		req := j.o.Reqs[m.Key]
		key := m.Key + "@" + m.File
		if seen[key] {
			continue
		}
		sc := j.specCommit(req)
		if sc.c == nil || sc.uncommitted {
			continue
		}
		fb, ok := fileBlame[m.File]
		if !ok {
			fb = blameOf(j.o.CodeRoot, m.File, true)
			fileBlame[m.File] = fb
		}
		if fb == nil {
			continue
		}
		text, ok := texts[m.File]
		if !ok {
			b, err := os.ReadFile(filepath.Join(j.o.CodeRoot, m.File))
			if err != nil {
				continue
			}
			text = string(b)
			texts[m.File] = text
		}
		if IsGenerated(m.File, text) {
			continue
		}
		if units[m.File] == nil {
			by := map[int][]Unit{}
			for _, x := range Analyze(text) {
				by[x.Line] = append(by[x.Line], x)
			}
			units[m.File] = by
		}
		var u *Unit
		for i := range units[m.File][m.Line] {
			if units[m.File][m.Line][i].Key == m.Key {
				u = &units[m.File][m.Line][i]
				break
			}
		}
		if u == nil {
			continue
		}
		lines := strings.Split(text, "\n")
		var latest *commit
		for i := u.Start; i <= u.End && i < len(lines); i++ {
			if blank(lines[i]) || commentLine.MatchString(lines[i]) || i >= len(fb.PerLine) {
				continue
			}
			sha := fb.PerLine[i]
			if sha == "" || zeroSHA.MatchString(sha) {
				continue
			}
			c := fb.Info[sha]
			if c == nil || j.touchesSpec(sha, req.Cap) {
				continue
			}
			if j.newer(c, latest, "") {
				latest = c
			}
		}
		if latest == nil {
			continue
		}
		var later bool
		if j.same {
			later = !j.isAnc(latest.SHA, sc.c.SHA, "") && (latest.Time > sc.c.Time || j.isAnc(sc.c.SHA, latest.SHA, ""))
		} else {
			later = latest.Time > sc.c.Time
		}
		if !later {
			continue
		}
		seen[key] = true
		stale = append(stale, StaleAnchor{Key: m.Key, File: m.File, Line: m.Line, Header: u.Header, Commit: latest.SHA, Subject: latest.Summary, SpecCommit: sc.c.SHA, SpecSj: sc.c.Summary})
	}
	return stale
}
