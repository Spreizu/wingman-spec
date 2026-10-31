// Package wingmanspec holds the files `wingman-spec init` installs into a project: the harness sources (commands,
// subagents, partials and the AGENTS block) and the bundled skills. The CLI lives in cmd/wingman-spec.
package wingmanspec

import (
	"embed"
	"io/fs"
)

//go:embed harness
var harness embed.FS

//go:embed skills
var skills embed.FS

// Harness is the harness/ tree: commands/*.md, agents/*.md, partials/*.md and AGENTS.block.md.
func Harness() fs.FS { s, _ := fs.Sub(harness, "harness"); return s }

// Skills is the skills/ tree: one folder per skill (the folders without a SKILL.md are not skills).
func Skills() fs.FS { s, _ := fs.Sub(skills, "skills"); return s }
