package verify

import (
	"cmp"
	"fmt"
	"path/filepath"
	"slices"

	"github.com/Spreizu/wingman-spec/internal/anchors"
	"github.com/Spreizu/wingman-spec/internal/testpaths"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

// AffectedNote says what `finish --affected` cannot see.
const AffectedNote = "--affected follows @spec markers: a test of changed code that carries no marker and no tag of an affected requirement is not run; run plain `finish` when markers are sparse"

type affectedSet struct {
	files, keys []string
}

// affectedTests is `finish --affected`: the requirements the change touches (its ADDED, MODIFIED and renamed ones, and
// those whose @spec-anchored code units changed since the change began), then their tests (tagged with their
// scenarios or carrying their markers), plus the changed test files and the tests named after the changed sources.
func (e *Env) affectedTests(changeDir string) affectedSet {
	base := e.changeBase()
	diffBase := cmp.Or(base, "HEAD")
	tr := e.paths()
	keys := anchors.TouchedKeys(e.code, diffBase, func(f string) bool { return testpaths.IsTestPath(f) || tr.IsSpecPath(f) })
	var src []string
	for _, f := range uniq(append(e.namesSince(diffBase), e.changedFiles()...)) {
		if !testpaths.IsTestPath(f) && !tr.IsSpecPath(f) {
			src = append(src, f)
		}
	}
	for _, d := range trace.Deltas(changeDir) {
		for _, q := range d.Reqs {
			if q.Op == "ADDED" || q.Op == "MODIFIED" {
				keys[d.Cap+"/"+q.Slug] = true
			}
		}
		for _, rn := range d.Renames {
			keys[d.Cap+"/"+rn.ToSlug] = true
		}
	}
	eff := trace.Effective(e.R.LivingSpecs(), changeDir)
	all := e.testFiles()
	tags := e.traceTags(all)
	var files []string
	for k := range keys {
		if r, ok := eff.Get(k); ok {
			for _, s := range r.Scenarios {
				files = append(files, tags[r.Cap+"/"+s.Slug]...)
			}
		}
	}
	if len(all) > 0 {
		for _, m := range tr.ScanAnchors(all) {
			if keys[m.Key] {
				files = append(files, m.File)
			}
		}
	}
	files = slices.Concat(files, e.changedTestFiles(base), testpaths.TestsFor(src, all))
	out := affectedSet{files: []string{}, keys: []string{}}
	for _, f := range uniq(files) {
		if exists(filepath.Join(e.code, f)) {
			out.files = append(out.files, f)
		}
	}
	for k := range keys {
		if eff.Has(k) {
			out.keys = append(out.keys, k)
		}
	}
	slices.Sort(out.files)
	slices.Sort(out.keys)
	return out
}

// affectedCmd is the test command for `finish --affected`, or the full one with the reason when it cannot be narrowed.
func (e *Env) affectedCmd(changeDir, full string, o *outcome) (string, *Obj) {
	tpl, _, why := e.targetedTemplate(full)
	if tpl == "" {
		o.warn("finish --affected ran the full suite: " + why)
		return full, O("full_suite", why)
	}
	a := e.affectedTests(changeDir)
	if len(a.files) == 0 {
		o.warn("finish --affected ran the full suite: no test file was found for the change's requirements")
		return full, O("full_suite", "no affected test file")
	}
	o.warn(fmt.Sprintf("finish --affected ran %d test file(s) for %d requirement(s); %s; the archive gate needs a plain `finish`.", len(a.files), len(a.keys), AffectedNote))
	return testpaths.WithFiles(tpl, a.files), O("files", a.files, "requirements", a.keys, "note", AffectedNote)
}
