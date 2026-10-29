# Adopt sample: helpdesk

A small Node order desk with seeded problems, used to measure `/spec-adopt` (see ANSWER-KEY.txt).

- `helpdesk/`: the code (5 tests pass: `node --test`).
- `before/`: what the previous adopt wrote (specs only; its questions lived in the chat summary, `SUMMARY.md`).
- `after/`: what the current adopt writes (specs with `Confirmed:` lines, plus `observed/`).

Both were produced by one agent following the command text of the time, so this is a regression fixture and one measurement, not a benchmark. `tests/adopt.sh` scores both mechanically.
