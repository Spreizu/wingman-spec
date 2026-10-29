# Test files and tags per language

`openspec/scripts/testpaths.cjs` is the one definition of "this file is a test". The scripts (`listTestFiles`, trace, `finish`, `check`, `drift`) and the editor extension (code view, branch review, requirement counts) use it. A test file is found by its directory (whole path segment, any case: `tests/`, `test/`, `__tests__/`, `spec/`, .NET `Foo.Tests/`, `FooTests/`) or by its name (suffix forms are case-sensitive: `FooTest.php`, not `contest.php`). It must have a code extension to be read for tags. The tag is `[<capability>/<scenario-slug>]` anywhere in the file; the anchor `@spec <capability>/<requirement-slug>` is read in every source file after any comment leader (`//`, `#`, `/*`, `*`, `--`, `;`, `%`).

| Language | Test files | Carry the tag in |
|---|---|---|
| JavaScript, TypeScript | `*.test.*`, `*.spec.*` (`js jsx ts tsx mjs cjs mts cts`), test dirs | the test title: `it('[cap/slug] ...')` |
| Vue, Svelte | `*.test.vue`, `*.spec.vue`, `*.test.svelte`, `*.spec.svelte`, test dirs (`Foo.vue` itself is a component, not a test) | a comment or the test title |
| Python | `test_*.py`, `*_test.py`, test dirs | docstring or `#` comment |
| Go | `*_test.go` | `t.Run("[cap/slug] ...")` or a comment |
| Ruby | `*_spec.rb`, `*_test.rb`, `test_*.rb`, `spec/`, `test/` | `it "[cap/slug] ..."` |
| Rust | `tests/` | a comment above `#[test]` (fn names cannot hold brackets) |
| PHP | `*Test.php`, `*Tests.php`, `tests/`, `Tests/` | docblock, `#[TestDox('[cap/slug] ...')]`, `//` comment |
| Java | `*Test.java`, `*Tests.java`, `*IT.java`, `*ITCase.java`, `Test*.java`, `src/test/` | `@DisplayName("[cap/slug] ...")`, Javadoc, comment |
| Kotlin | the Java forms plus `*Spec.kt` (`.kt`, `.kts`) | backticked name, `@DisplayName`, comment |
| Scala | the Java forms plus `*Spec.scala`, `*Suite.scala` | `test("[cap/slug] ...")`, comment |
| C#, .NET | `*Test.cs`, `*Tests.cs`, `*.Tests/`, `*Tests/` | `[Fact(DisplayName = "[cap/slug] ...")]`, `[Trait("scenario", "[cap/slug]")]`, comment |
| Swift | `*Tests.swift`, `*Test.swift`, `*Spec.swift`, `Tests/` | `//` or `///` comment |
| Dart | `*_test.dart`, `test/` | `test('[cap/slug] ...')` |
| Elixir | `*_test.exs`, `test_*.exs`, `test/` | `test "[cap/slug] ..."` |
| C, C++ | `*_test.{c,cc,cpp,cxx}`, `*_unittest.{cc,cpp,cxx}`, `*Test.{cc,cpp,cxx}`, `test/`, `tests/` | `//` or `/* */` comment |
| Clojure, Lua | `*_test.clj`, `*_spec.lua`, `*_test.lua`, `test/`, `spec/` | docstring or comment, `it("[cap/slug] ...")` |

Not detected: tests inside source files (Rust `#[cfg(test)]`, Zig, D), test files with a name outside these forms (`tests.py`, Pest `*.test.php`, `*Specs.cs`), and other languages (Haskell, R, Perl, Objective-C) unless the file sits in a test directory and its extension is one of the code extensions in `testpaths.cjs`.
