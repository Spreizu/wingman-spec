'use strict';
// One table for the per-language checks (tests/testpaths.sh and vscode-extension/test/langs.test.ts): per language a source file
// with a `@spec` anchor and a test file under that language's conventional name, with the scenario tags carried the idiomatic way
// (test-name string, annotation argument, doc comment, comment). Capability `lang-<id>`, requirement "Greet a user", scenarios works / fails.
const REQ = 'greet-a-user';
const L = (id, src, test, srcText, testText) => ({ id, cap: `lang-${id}`, req: REQ, src, test, srcText: srcText.replace(/@@/g, `lang-${id}/${REQ}`), testText: testText.replace(/@@/g, `lang-${id}`) });

const LANGS = [
  L('js', 'src/greet.js', 'test/greet.test.js',
    '// @spec @@\nexports.greet = (n) => `hi ${n}`;\n',
    "const { test } = require('node:test');\ntest('[@@/works] says hi', () => {});\ntest('[@@/fails] rejects an empty name', () => {});\n"),
  L('ts', 'src/greet.ts', 'src/greet.spec.ts',
    '// @spec @@\nexport const greet = (n: string): string => `hi ${n}`;\n',
    "import { it } from 'vitest';\nit('[@@/works] says hi', () => {});\nit('[@@/fails] rejects an empty name', () => {});\n"),
  L('python', 'greeting/greet.py', 'greeting/greet_test.py',
    '# @spec @@\ndef greet(n):\n    return f"hi {n}"\n',
    'def test_works():\n    """[@@/works] says hi"""\n\n\ndef test_fails():\n    # [@@/fails] rejects an empty name\n    pass\n'),
  L('go', 'greet/greet.go', 'greet/greet_test.go',
    'package greet\n\n// @spec @@\nfunc Greet(n string) string { return "hi " + n }\n',
    'package greet\n\nimport "testing"\n\nfunc TestGreet(t *testing.T) {\n\tt.Run("[@@/works] says hi", func(t *testing.T) {})\n\tt.Run("[@@/fails] rejects an empty name", func(t *testing.T) {})\n}\n'),
  L('ruby', 'lib/greet.rb', 'spec/greet_spec.rb',
    '# @spec @@\ndef greet(n) = "hi #{n}"\n',
    'RSpec.describe "greet" do\n  it "[@@/works] says hi" do\n  end\n\n  it "[@@/fails] rejects an empty name" do\n  end\nend\n'),
  L('rust', 'src/lib.rs', 'tests/greet.rs',
    '// @spec @@\npub fn greet(n: &str) -> String { format!("hi {n}") }\n',
    '#[test]\nfn works() {\n    // [@@/works] says hi\n}\n\n/// [@@/fails] rejects an empty name\n#[test]\nfn fails() {}\n'),
  L('php', 'src/Greet/Greet.php', 'src/Greet/GreetTest.php',
    '<?php\n\n/**\n * @spec @@\n */\nfunction greet(string $n): string { return "hi $n"; }\n',
    '<?php\n\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class GreetTest extends TestCase\n{\n    /** [@@/works] says hi */\n    public function testWorks(): void {}\n\n    #[TestDox(\'[@@/fails] rejects an empty name\')]\n    public function testFails(): void {}\n}\n'),
  L('java', 'src/main/java/app/Greet.java', 'src/test/java/app/GreetTest.java',
    '/**\n * @spec @@\n */\npublic class Greet {\n  public static String greet(String n) { return "hi " + n; }\n}\n',
    'import org.junit.jupiter.api.DisplayName;\nimport org.junit.jupiter.api.Test;\n\nclass GreetTest {\n  @Test\n  @DisplayName("[@@/works] says hi")\n  void works() {}\n\n  @Test // [@@/fails] rejects an empty name\n  void fails() {}\n}\n'),
  L('kotlin', 'src/main/kotlin/Greet.kt', 'src/test/kotlin/GreetTest.kt',
    '// @spec @@\nfun greet(n: String) = "hi $n"\n',
    'import org.junit.jupiter.api.Test\nimport org.junit.jupiter.api.DisplayName\n\nclass GreetTest {\n    @Test\n    fun `[@@/works] says hi`() {}\n\n    @Test\n    @DisplayName("[@@/fails] rejects an empty name")\n    fun fails() {}\n}\n'),
  L('scala', 'src/main/scala/Greet.scala', 'src/test/scala/GreetSpec.scala',
    '// @spec @@\nobject Greet { def greet(n: String) = s"hi $n" }\n',
    'import org.scalatest.funsuite.AnyFunSuite\n\nclass GreetSpec extends AnyFunSuite {\n  test("[@@/works] says hi") {}\n  test("[@@/fails] rejects an empty name") {}\n}\n'),
  L('csharp', 'Greet/Greet.cs', 'Greet.Tests/GreetTests.cs',
    '// @spec @@\npublic static class Greeter { public static string Greet(string n) => $"hi {n}"; }\n',
    'using Xunit;\n\npublic class GreetTests\n{\n    [Fact(DisplayName = "[@@/works] says hi")]\n    public void Works() {}\n\n    [Fact]\n    [Trait("scenario", "[@@/fails]")]\n    public void Fails() {}\n}\n'),
  L('swift', 'Sources/Greet/Greet.swift', 'Tests/GreetTests/GreetTests.swift',
    '// @spec @@\npublic func greet(_ n: String) -> String { "hi \\(n)" }\n',
    'import XCTest\n\nfinal class GreetTests: XCTestCase {\n    func testWorks() { // [@@/works] says hi\n    }\n\n    /// [@@/fails] rejects an empty name\n    func testFails() {}\n}\n'),
  L('dart', 'lib/greet.dart', 'test/greet_test.dart',
    '// @spec @@\nString greet(String n) => "hi $n";\n',
    "import 'package:test/test.dart';\n\nvoid main() {\n  test('[@@/works] says hi', () {});\n  test('[@@/fails] rejects an empty name', () {});\n}\n"),
  L('elixir', 'lib/greet.ex', 'test/greet_test.exs',
    '# @spec @@\ndefmodule Greet do\n  def greet(n), do: "hi #{n}"\nend\n',
    'defmodule GreetTest do\n  use ExUnit.Case\n\n  test "[@@/works] says hi" do\n  end\n\n  test "[@@/fails] rejects an empty name" do\n  end\nend\n'),
  L('cpp', 'src/greet.cpp', 'test/greet_test.cc',
    '// @spec @@\n#include <string>\nstd::string greet(const std::string& n) { return "hi " + n; }\n',
    '#include <gtest/gtest.h>\n\nTEST(Greet, Works) {  // [@@/works] says hi\n}\n\n/* [@@/fails] rejects an empty name */\nTEST(Greet, Fails) {}\n'),
  L('c', 'src/greet.c', 'test/test_greet.c',
    '/* @spec @@ */\nconst char *greet(void) { return "hi"; }\n',
    '/* [@@/works] says hi */\nvoid test_works(void) {}\n\n// [@@/fails] rejects an empty name\nvoid test_fails(void) {}\n'),
  L('clojure', 'src/app/greet.clj', 'test/app/greet_test.clj',
    ';; @spec @@\n(ns app.greet)\n(defn greet [n] (str "hi " n))\n',
    '(ns app.greet-test (:require [clojure.test :refer :all]))\n\n(deftest works "[@@/works] says hi" (is true))\n(deftest fails ;; [@@/fails] rejects an empty name\n  (is true))\n'),
  L('lua', 'src/greet.lua', 'spec/greet_spec.lua',
    '-- @spec @@\nreturn function(n) return "hi " .. n end\n',
    'describe("greet", function()\n  it("[@@/works] says hi", function() end)\n  it("[@@/fails] rejects an empty name", function() end)\nend)\n'),
];

/** A project-relative path -> file text, for one language or all. */
const files = (langs = LANGS) => Object.fromEntries(langs.flatMap((l) => [[l.src, l.srcText], [l.test, l.testText]]));

/** The spec of one capability: one requirement, two scenarios (plain text, with a Why line). */
const spec = (l) => `## Purpose\nGreets a user by name in ${l.id}, so that every language of the team shows the same behaviour.\n\n## Requirements\n\n### Requirement: Greet a user\nThe system SHALL greet a user by name.\nWhy: The team wants every language to greet users the same way.\n\n#### Scenario: Works\n- **WHEN** a name is given\n- **THEN** the greeting contains the name\n\n#### Scenario: Fails\n- **WHEN** the name is empty\n- **THEN** the greeting is refused\n`;

module.exports = { LANGS, REQ, files, spec };
