---
name: spec-writing
description: >
  Write short, concrete specs, proposals, tasks and design notes. Use while writing or editing a proposal.md, a spec
  delta (requirements, WHEN/THEN scenarios), tasks.md or design.md, or when lint warns about vague or long wording.
license: MIT
---
# Spec writing

A spec is read by an agent that does exactly what it says. Write so that every sentence can be checked.

## Rules

1. One statement per sentence, 25 words or fewer. Split a sentence that has a semicolon, a colon and a parenthesis.
2. Actor first, active voice. An instruction starts with a verb: "Run", "Write", "Stop".
3. Concrete nouns with a value: "the invoice list", "error `AMOUNT_REQUIRED`", "3 rows". No bare "data", "input" or "thing".
4. WHEN states one action or input. THEN states one value a test can assert, plus one thing that did not change.
5. Use a list for 3 or more parallel items and a table for 2 or more attributes per item.
6. At most one parenthesis per sentence. A parenthesis longer than 8 words becomes its own sentence.
7. State a rule once, where it belongs, and point to it elsewhere.
8. A finding or error message ends with the action that fixes it.
9. No filler or hedges: "really", "just", "simply", "in order to", "as needed", "where relevant", "properly",
   "gracefully", "appropriate".
10. Name a thing the same way every time.

## Before and after

Before:

```markdown
### Requirement: Invoice list
The system SHALL display invoices appropriately and handle overdue ones properly (and also deal with
missing amounts, which can happen for imported invoices, in a graceful way).

#### Scenario: Overdue invoice
- **WHEN** an invoice is overdue
- **THEN** it is handled correctly
```

After:

```markdown
### Requirement: Invoice list
The system SHALL list invoices newest first and mark each overdue invoice.
Why: Accounts staff chase overdue invoices first, so they must see them without opening each one.

#### Scenario: Overdue invoice is marked
- **WHEN** invoice "INV-104" has due date 2026-03-01 and today is 2026-03-15
- **THEN** its row shows the badge "Overdue"
- **AND** invoice "INV-105", due 2026-04-01, shows no badge

#### Scenario: Imported invoice without an amount
- **WHEN** imported invoice "INV-200" has no amount
- **THEN** its amount cell shows "—" and the list total excludes it
```

What changed: one claim per requirement, a Why line, a value in every THEN, and one thing that did not change.
"Handled correctly" became a badge a test can check.
