'use strict';
/**
 * testpaths.cjs - the one definition of file kinds: which files are tests, which can carry a `[capability/scenario]` tag. The one definition:
 * quality.cjs (`listTestFiles`, `isTestPath`), traceability.cjs, verify-task.cjs and the editor extension all use it.
 * Plain Node >= 18, no dependencies. Paths are relative and `/`-separated. Whole path segments and suffix forms only
 * (`latest/`, `contest.py`, `attest.go`, `testing-utils.ts` are not tests). Inline tests (Rust `#[cfg(test)]`) are out of scope.
 *
 *   isTestPath(path)   a test by directory or file name
 *   isTestFile(path)   a test path with a code extension: the files scanned for tags
 *   CODE_EXT_RE        the code/test extensions (one list; greenfield.cjs scans sources with it too)
 *   isUiFile           UI files (components, markup, styles): UX checklist, visual tasks, the visual check default
 *   testsFor(sources, tests)  the test files named after the given source files (`cart.ts` -> `cart.test.ts`, `test_cart.py`, `CartTest.java`)
 *   targetedTemplate(cmd, script)  a `<runner> {files}` command from the project test command (a small table of runners)
 */

const CODE_EXT = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'go', 'rb', 'rs', 'php', 'java', 'kt', 'kts', 'scala', 'cs', 'swift', 'dart', 'ex', 'exs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'clj', 'lua', 'sh'];
const CODE_EXT_RE = new RegExp(`\\.(?:${CODE_EXT.join('|')})$`, 'i');

const UI_EXT = ['vue', 'svelte', 'tsx', 'jsx', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'pcss'];
/** A UI file by extension; `exts` overrides the list (`visual.ui_files`). */
const isUiFile = (f, exts = UI_EXT) => exts.includes((String(f).split('.').pop() || '').toLowerCase());

// Directory names (any case): tests/ test/ __tests__/ spec/ (Java `src/test/`, Rust `tests/`, .NET `Tests/`, Swift `Tests/` ...).
const TEST_DIR = /^(?:tests?|__tests__|spec)$/i;
// .NET project folders: `App.Tests`, `App.Test`, `AppTests` (capital T keeps `latest`, `Contests` out).
const TEST_PROJECT_DIR = /\.Tests?$|[a-z0-9]Tests$/;

// File names, case-sensitive where the convention is (`FooTest.php`, not `Latest.php`).
const TEST_NAME = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|vue|svelte)$/,           // JS/TS, Vue, Svelte
  /^test_.+\.(?:py|rb|exs?)$|_test\.(?:py|go|rb|dart|exs|c|cc|cpp|cxx|clj|lua)$/, // Python, Go, Ruby, Dart, Elixir, C/C++, Clojure, Lua
  /_spec\.(?:rb|lua)$/,                                      // RSpec, busted
  /_unittest\.(?:cc|cpp|cxx)$/,                              // gtest
  /Tests?\.(?:php|cs|swift|cpp|cc|cxx)$/,                    // PHPUnit, .NET, XCTest, C++
  /(?:Test|Tests|Spec|Suite)\.(?:kt|kts|scala)$|Tests?\.(?:java)$/, // JUnit, Kotest, ScalaTest
  /[a-z0-9]IT(?:Case)?\.(?:java|kt|kts|scala)$/,             // integration tests: UserRepositoryIT.java
  /^Test[A-Z0-9_].*\.(?:java|kt|kts|scala)$/,                // TestUserService.java
  /Spec\.swift$/,                                            // Quick
];

/** A test by directory or file name. */
function isTestPath(f) {
  const parts = String(f).split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((s) => TEST_DIR.test(s) || TEST_PROJECT_DIR.test(s))) return true;
  return TEST_NAME.some((re) => re.test(name));
}

/** A test path that can carry a tag: code extension only (`tests/fixtures/data.json` is not scanned). */
const isTestFile = (f) => isTestPath(f) && CODE_EXT_RE.test(String(f));

// The name a test file is about: its file name without the test prefix or suffix and the extension.
const TEST_AFFIX = [/\.(?:test|spec)$/i, /^test_/, /_(?:test|spec|unittest)$/, /^Test(?=[A-Z0-9_])/, /(?:Tests?|Spec|Suite|IT|ITCase)$/];
function testStem(f) {
  let n = String(f).split('/').pop().replace(/\.[^.]+$/, '');
  for (const re of TEST_AFFIX) n = n.replace(re, '');
  return n.toLowerCase();
}
const sourceStem = (f) => {
  const parts = String(f).split('/'); const n = parts.pop().replace(/\.[^.]+$/, '').replace(/\.d$/, '');
  return (/^(?:index|main|mod|__init__)$/i.test(n) && parts.length ? parts.pop() : n).toLowerCase();
};
/** The test files (from `tests`) whose name is about one of the `sources`: `src/cart.ts` -> `test/cart.test.ts`, `src/cart/index.ts` -> `cart.spec.ts`. */
function testsFor(sources, tests) {
  const want = new Set(sources.filter((f) => !isTestPath(f) && CODE_EXT_RE.test(f)).map(sourceStem));
  return want.size ? tests.filter((t) => want.has(testStem(t))) : [];
}

// [runner in the test command, what replaces the match (null: the match), the argument form, which options are kept]. The template is the
// command up to the runner, its options and the files. Options: `=` keeps `--flag=value` only (the runner has flags that take a
// separate value, such as `pytest -k EXPR`); `all` keeps every `-x` / `--flag` (they take no value). `{dirs}`: package directories
// (`go test ./pkg/cart`). A runner not in the table: set `- Targeted test command:`.
const TARGETED_RUNNERS = [
  [/\bvitest\b(?:\s+run\b)?/, 'vitest run', '{files}', '='], [/\bjest\b/, null, '{files}', '='], [/\bmocha\b/, null, '{files}', '='],
  [/\bava\b/, null, '{files}', '='], [/\bnode\b(?:\s+--?[\w-]+(?:=\S+)?)*?\s+--test\b/, null, '{files}', 'all'],
  [/\b(?:python3?\s+-m\s+)?pytest\b/, null, '{files}', '='], [/\brspec\b/, null, '{files}', '='],
  [/\bdeno\s+test\b/, null, '{files}', 'all'], [/\bbun\s+test\b/, null, '{files}', 'all'], [/\bgo\s+test\b/, null, '{dirs}', '='],
];
const WRAPPER = /^(?:(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?|bun\s+run\s+)([\w:.-]+)\s*$/;
/** A `{files}` template from a test command, or null: one segment of `a && b` names a runner the table knows. `script(name)`: a package.json script (`npm test`). */
function targetedTemplate(cmd, script, depth = 0) {
  for (const seg of String(cmd || '').split(/\s*(?:&&|\|\||;)\s*/)) {
    const w = seg.trim().match(WRAPPER);
    if (w && depth === 0) {
      const body = script && script(w[1]);
      const t = body && targetedTemplate(body, script, 1);
      if (t) return /^(?:npx|node|deno|bun|go|python|pytest|rspec|bundle|env|\w+=)/.test(t) ? t : `npx ${t}`;
      continue;
    }
    for (const [re, use, args, keep] of TARGETED_RUNNERS) {
      const m = seg.match(re); if (!m) continue;
      const opts = seg.slice(m.index + m[0].length).trim().split(/\s+/).filter((x) => (keep === 'all' ? /^-/.test(x) : /^--[\w-]+=\S+$/.test(x)));
      return [seg.slice(0, m.index).trim(), use || m[0], ...opts, args].filter(Boolean).join(' ');
    }
  }
  return null;
}
module.exports = { CODE_EXT_RE, isUiFile, isTestPath, isTestFile, testsFor, targetedTemplate };
