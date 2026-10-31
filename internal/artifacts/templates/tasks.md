<!-- No Size line here: proposal.md has it. It caps the implementation tasks at 3 / 5 / 8 for S / M / L; review tasks do not count. `wingman-spec lint` enforces the cap. -->

## 1. <!-- group name; group 1 is the walking skeleton. Add "(risky)" when the group touches security, money, migrations, concurrency or a public API; a risky group gets its own review -->

- [ ] 1.1 <!-- Task description: one red/green/refactor cycle. Merge consecutive tasks on the same file. -->
  - Spec: <!-- capability > Requirement name (Scenario name, Scenario name) or (all scenarios) -->
  - Test first: <!-- <file>: <what the test asserts>. The title starts with [capability/scenario-slug]. The test checks behaviour, not source text. -->
  - Files: <!-- files likely created or touched -->
  - Done when: <!-- the observable result and the command that must pass, in backticks: `npm test -- due` exits 0 -->
- [ ] 1.2 <!-- Task description -->
  - Spec:
  - Test first:
  - Files:
  - Visual: <!-- UI tasks only: visual scenario ids this task makes true, e.g. pricing/header-on-a-phone; delete otherwise -->
  - Done when:
<!-- Size L: end group 1 with "- [ ] 1.R Request code review for group 1". Any size: the same after a (risky) group. -->

## 2. <!-- Group name -->

- [ ] 2.1 <!-- Task description -->
  - Spec:
  - Test first:
  - Files:
  - Done when:
- [ ] 2.R Request code review of the whole change <!-- Size M/L, a Risk kind or UI only; delete on a fast change. May fix findings in any file this change's tasks name in Files: -->
  - Done when: review findings of Critical/Important severity are fixed and re-verified

<!-- No close-out tasks. After the last task, `wingman-spec finish` runs the full tests, typecheck, lint,
     `wingman-spec validate`, every visual scenario and the trace check, without an agent. -->
