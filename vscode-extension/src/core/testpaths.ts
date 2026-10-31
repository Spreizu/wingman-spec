/**
 * The one definition of file kinds: which files are tests, which can carry a `[capability/scenario]` tag, which are UI files.
 * A TS port of the CLI's internal/testpaths; test/golden/testpaths.json (written by the Go suite) keeps the two in step.
 * Paths are relative and `/`-separated. Whole path segments and suffix forms only (`latest/`, `contest.py` are not tests).
 */

const CODE_EXT = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'go', 'rb', 'rs', 'php', 'java', 'kt', 'kts', 'scala', 'cs', 'swift', 'dart', 'ex', 'exs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'clj', 'lua', 'sh'];
export const CODE_EXT_RE = new RegExp(`\\.(?:${CODE_EXT.join('|')})$`, 'i');

const UI_EXT = ['vue', 'svelte', 'tsx', 'jsx', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'pcss'];
/** A UI file by extension; `exts` overrides the list (`visual.ui_files`). */
export const isUiFile = (f: string, exts: string[] = UI_EXT): boolean => exts.includes((f.split('.').pop() ?? '').toLowerCase());

// Directory names (any case): tests/ test/ __tests__/ spec/; .NET project folders `App.Tests`, `AppTests` (capital T keeps `latest` out).
const TEST_DIR = /^(?:tests?|__tests__|spec)$/i;
const TEST_PROJECT_DIR = /\.Tests?$|[a-z0-9]Tests$/;
const TEST_NAME = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|vue|svelte)$/,
  /^test_.+\.(?:py|rb|exs?)$|_test\.(?:py|go|rb|dart|exs|c|cc|cpp|cxx|clj|lua)$/,
  /_spec\.(?:rb|lua)$/,
  /_unittest\.(?:cc|cpp|cxx)$/,
  /Tests?\.(?:php|cs|swift|cpp|cc|cxx)$/,
  /(?:Test|Tests|Spec|Suite)\.(?:kt|kts|scala)$|Tests?\.(?:java)$/,
  /[a-z0-9]IT(?:Case)?\.(?:java|kt|kts|scala)$/,
  /^Test[A-Z0-9_].*\.(?:java|kt|kts|scala)$/,
  /Spec\.swift$/,
];

/** A test by directory or file name. */
export function isTestPath(f: string): boolean {
  const parts = f.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((s) => TEST_DIR.test(s) || TEST_PROJECT_DIR.test(s))) return true;
  return TEST_NAME.some((re) => re.test(name));
}

/** A test path that can carry a tag: code extension only (`tests/fixtures/data.json` is not scanned). */
export const isTestFile = (f: string): boolean => isTestPath(f) && CODE_EXT_RE.test(f);

const testPaths = { CODE_EXT_RE, isUiFile, isTestPath, isTestFile };
export default testPaths;
