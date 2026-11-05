package testpaths

import (
	"path"
	"regexp"
	"strings"
	"sync"
)

// Running only the tests of one review fix. A test belongs to fix <slug> when its name carries the tag
// `[review:<slug>]` (runners with free-text names) or the identifier `review_<slug>` with `_` for `-` (runners whose
// test names are identifiers; Go: `TestReview_<slug>`). Each runner gets one name filter; {re} matches both forms,
// {id} is the identifier, {tag} the tag, {slug} the slug. Slugs are [a-z0-9-], so the quotes below always hold.
type oneRunner struct {
	name    string
	detect  *regexp.Regexp // in the test command, the per-file command or the package.json test script
	markers []string       // else a file in the code root (globs allowed) ...
	base    string         // ... and this command
	filter  string
}

var oneRunners = []oneRunner{
	{"vitest", regexp.MustCompile(`\bvitest\b`), nil, "", `-t '{re}'`},
	{"jest", regexp.MustCompile(`\bjest\b`), nil, "", `-t '{re}'`},
	{"mocha", regexp.MustCompile(`\bmocha\b`), nil, "", `--grep '{re}'`},
	{"node:test", regexp.MustCompile(`\bnode\b.*\s--test\b`), nil, "", `--test-name-pattern='{re}'`},
	{"bun", regexp.MustCompile(`\bbun\s+test\b`), nil, "", `-t '{re}'`},
	{"deno", regexp.MustCompile(`\bdeno\s+test\b`), nil, "", `--filter '/{re}/'`},
	{"go", regexp.MustCompile(`\bgo\s+test\b`), []string{"go.mod"}, "go test ./...", `-run '{re}'`},
	{"pytest", regexp.MustCompile(`\bpytest\b`), []string{"pytest.ini", "conftest.py"}, "python -m pytest", `-k '{id}'`},
	{"cargo", regexp.MustCompile(`\bcargo\s+(?:\+\S+\s+)?test\b`), []string{"Cargo.toml"}, "cargo test", `'{id}'`},
	{"dotnet", regexp.MustCompile(`\bdotnet\s+test\b`), []string{"*.sln", "*.csproj", "*.fsproj"}, "dotnet test", `--filter 'FullyQualifiedName~{id}'`},
	{"maven", regexp.MustCompile(`\bmvnw?\b`), []string{"pom.xml"}, "mvn -q test", `-Dtest='*#*{id}*'`},
	{"gradle", regexp.MustCompile(`\bgradlew?\b`), []string{"build.gradle", "build.gradle.kts"}, "./gradlew test", `--tests '*{id}*'`},
	{"rspec", regexp.MustCompile(`\brspec\b`), []string{".rspec"}, "bundle exec rspec", `-e '{tag}'`},
	{"phpunit", regexp.MustCompile(`\bphpunit\b`), []string{"phpunit.xml", "phpunit.xml.dist"}, "vendor/bin/phpunit", `--filter '{re}'`},
	{"swift", regexp.MustCompile(`\bswift\s+test\b`), []string{"Package.swift"}, "swift test", `--filter '{re}'`},
	{"exunit", regexp.MustCompile(`\bmix\s+test\b`), []string{"mix.exs"}, "mix test", `--only 'review:{slug}'`},
	{"flutter", regexp.MustCompile(`\bflutter\s+test\b`), nil, "", `--name '{re}'`},
	{"dart", regexp.MustCompile(`\bdart\s+test\b`), []string{"pubspec.yaml"}, "dart test", `--name '{re}'`},
}

// OneTest says how to run the tests of one review fix.
type OneTest struct {
	Override string // commands.test_one: {name} a quoted regex for both forms, {id} the identifier, {tag} the quoted tag,
	// {files} / {file} the tagged files (quoted), {dirs} their folders
	PerFile string // the per-file command, with {files} or {dirs}; "" when none is known
	Test    string // the project test command
	Script  string // the package.json test script, for detection only
	Has     func(glob string) bool
}

// Command is the command for fix slug with its tagged files, and the mode: override, name:<runner> (only the
// tagged tests run), file (the tagged files run whole), suite (the whole test command), or "" (nothing to run).
func (o OneTest) Command(slug string, files []string) (cmd, mode string) {
	id := "review_" + strings.ReplaceAll(slug, "-", "_")
	re := `\[review:` + slug + `\]|[Rr]eview_` + id[7:]
	fill := strings.NewReplacer("{re}", re, "{id}", id, "{tag}", "[review:"+slug+"]", "{slug}", slug).Replace
	if o.Override != "" {
		t := strings.NewReplacer("{name}", shq(re), "{id}", id, "{tag}", shq("[review:"+slug+"]"), "{file}", "{files}").Replace(o.Override)
		return WithFiles(t, files), "override"
	}
	all := o.PerFile + " " + o.Test + " " + o.Script
	for _, r := range oneRunners {
		f := fill(r.filter)
		switch {
		case !r.detect.MatchString(all):
		case r.detect.MatchString(o.PerFile):
			at := "{files}"
			if !strings.Contains(o.PerFile, at) {
				at = "{dirs}"
			}
			return WithFiles(strings.Replace(o.PerFile, at, f+" "+at, 1), files), "name:" + r.name
		case r.detect.MatchString(o.Test) && !strings.Contains(o.Test, "&&"):
			return o.Test + " " + f, "name:" + r.name
		default:
			continue
		}
	}
	if o.PerFile == "" && o.Has != nil {
		for _, r := range oneRunners {
			for _, m := range r.markers {
				if r.base != "" && o.Has(m) {
					return r.base + " " + fill(r.filter), "name:" + r.name
				}
			}
		}
	}
	if o.PerFile != "" {
		return WithFiles(o.PerFile, files), "file"
	}
	if o.Test != "" {
		return o.Test, "suite"
	}
	return "", ""
}

var (
	reviewPats sync.Map
	neverRE    = regexp.MustCompile(`$^`)
)

func reviewPat(slug string) *regexp.Regexp {
	if v, ok := reviewPats.Load(slug); ok {
		return v.(*regexp.Regexp)
	}
	id := "eview_" + strings.ReplaceAll(slug, "-", "_")
	re, err := regexp.Compile(`[Rr]` + id + `(?:\b|_)`)
	if err != nil {
		re = neverRE
	}
	actual, _ := reviewPats.LoadOrStore(slug, re)
	return actual.(*regexp.Regexp)
}

// Tagged says whether a test file carries a test of fix slug: the tag, the identifier, or an ExUnit `@tag review:`.
func Tagged(text, slug string) bool {
	return strings.Contains(text, "[review:"+slug+"]") || reviewPat(slug).MatchString(text) ||
		strings.Contains(text, `review: "`+slug+`"`)
}

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// WithFiles fills {files} (the files, quoted) and {dirs} (their folders as ./dir) in a command.
func WithFiles(tpl string, files []string) string {
	var qf, dirs []string
	seen := map[string]bool{}
	for _, f := range files {
		qf = append(qf, shq(f))
		if d := shq("./" + path.Dir(f)); !seen[d] {
			seen[d] = true
			dirs = append(dirs, d)
		}
	}
	return strings.Replace(strings.Replace(tpl, "{files}", strings.Join(qf, " "), 1), "{dirs}", strings.Join(dirs, " "), 1)
}
