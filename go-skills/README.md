# Vendored Go skills (for agents working on the Go CLI)

| dir | upstream | commit | license | basis |
|---|---|---|---|---|
| golang-skills/ (20 skills: go-style-core, go-naming, go-error-handling, go-testing, go-packages, go-concurrency, go-context, go-interfaces, go-code-review, go-linting, ...) | https://github.com/cxuu/golang-skills | 91f0c2eef559a3168f9d3c38f5f99936d472b508 (2026-06-19) | Apache-2.0 (+ THIRD_PARTY_NOTICES: Google style guide CC-BY-3.0, Effective Go / CodeReviewComments BSD-3, Uber guide Apache-2.0) | Effective Go, Google Go Style Guide, Uber Go Style Guide, Go Wiki CodeReviewComments; agentskills.io format, progressive disclosure |
| golang-modernize/ | https://github.com/samber/cc-skills-golang | 246b6c4c1ab3077dee114beb9ade3bb0527dfebc (2026-10-23) | MIT | Go 1.27 language/stdlib idioms, `go fix`, modernize analyzers (complements the above, which predates Go 1.27) |

Files are byte-identical copies of upstream; refresh by re-cloning at a newer commit and updating this table.
Target toolchain: Go 1.27.3 (latest stable on go.dev/dl, checked 2026-10-29); go.mod `go 1.27`.

Agents working on `cmd/` and `internal/` read `golang-skills/go-style-core/SKILL.md` first, then the skill for the task at hand
(`go-error-handling`, `go-testing`, `go-concurrency`, ...), and `golang-modernize/SKILL.md` for Go 1.27 idioms. These skills are for
developing Wingman Spec itself; they are not installed into user projects.
