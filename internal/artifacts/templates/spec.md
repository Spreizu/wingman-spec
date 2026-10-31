## Purpose
<!-- New capabilities only: one or two sentences (50+ characters) on what this capability is for. Delete this section for an existing capability. -->

## ADDED

### Requirement: <!-- requirement name -->
<!-- The system SHALL ... (one statement) -->
Why: <!-- <role> wants <outcome>, so that <reason>. Example: The account owner wants to reset a forgotten password, so that they are not locked out. -->

#### Scenario: <!-- happy path -->
- **WHEN** <!-- one concrete action or input: "the user saves the title `Rent`" -->
- **THEN** <!-- one value a test can assert: "the list shows `Rent` as its first item" -->

#### Scenario: <!-- error or boundary case -->
- **WHEN** <!-- one concrete invalid input or limit: "the user saves an empty title" -->
- **THEN** <!-- the exact code or text, and one thing that did not change: "error TITLE_REQUIRED; no record is created" -->

#### Scenario: Invariant: <!-- what always holds; only for a requirement that computes, transforms, sorts or stores data -->
- **WHEN** <!-- the operation runs on a concrete input, and the result is then edited: "the total is built from 3 invoices, then one result row is edited" -->
- **THEN** <!-- one fact that always holds, as a value: "the input still has 3 invoices, unchanged and in the same order" -->

<!-- UI scenario: add a visual block under the WHEN/THEN lines (see the specs instruction). Example:
#### Scenario: Result list on a phone
- **WHEN** the results page is opened 375px wide
- **THEN** the cards `[data-testid="result-card"]` are in one column and nothing scrolls sideways

```visual
route: /
component: ResultList
viewports: 375, 768, 1280
key: [data-testid="search"]
key: [data-testid="result-card"]
expect: [data-testid="search"] above [data-testid="result-card"]
state: no-results
  do: fill [data-testid="search"] = zzz
  key: [data-testid="empty-state"]
  expect: [data-testid="search"] above [data-testid="empty-state"]
```
Block-level key: lines hold in every state. Block-level expect: lines hold on the loaded page only.
A fact for one state goes indented under it: the no-results state has no result cards, so it states its own layout fact.
-->
