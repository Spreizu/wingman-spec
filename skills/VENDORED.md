# Vendored skills

Verbatim, unmodified copies of third-party skills, pinned to upstream commits (see `vendor.lock`).
Upstreams are MIT licensed (obra/superpowers, mattpocock/skills, DietrichGebert/ponytail).
Refresh with `scripts/vendor-skills.sh --update`; check integrity with `scripts/vendor-skills.sh --verify`.

| Skill | Upstream | Path | Commit | License |
|-------|----------|------|--------|---------|
| `test-driven-development` | [obra/superpowers](https://github.com/obra/superpowers) | `skills/test-driven-development` | `bb92a7774141` | MIT |
| `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) | `skills/systematic-debugging` | `bb92a7774141` | MIT |
| `requesting-code-review` | [obra/superpowers](https://github.com/obra/superpowers) | `skills/requesting-code-review` | `bb92a7774141` | MIT |
| `verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers) | `skills/verification-before-completion` | `bb92a7774141` | MIT |
| `grilling` | [mattpocock/skills](https://github.com/mattpocock/skills) | `skills/productivity/grilling` | `5beb35b040e3` | MIT |
| `ponytail` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `skills/ponytail` | `7801d061243d` | MIT |
| `ponytail-review` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `skills/ponytail-review` | `7801d061243d` | MIT |

Notes:
- `grilling` is used directly; upstream's `grill-me` is only a one-line stub that calls it, so it is not bundled.
- `verification-before-completion` is bundled because `systematic-debugging` references it.
- Only `ponytail` and `ponytail-review` are bundled from DietrichGebert/ponytail (not audit/debt/gain/help or Cursor hooks).
- Upstream text such as the `superpowers:` prefix is intentionally left untouched.
