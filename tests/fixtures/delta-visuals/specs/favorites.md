## MODIFIED

### Requirement: List shows availability
The favorites list SHALL show only saved items that can be ordered, and omit the others.
Why: The shopper wants to see at a glance what can be ordered, so that they do not open each item.

#### Scenario: Available item shows an add button
- **WHEN** the shopper has item `42` saved and it is in stock
- **THEN** `/favorites` shows one row for item `42` with an enabled `[data-testid="favorite-add"]`

```visual
route: /favorites
key: [data-testid="favorites-list"]
key: [data-testid="favorite-add"]
```

#### Scenario: Unavailable item is omitted
- **WHEN** the shopper has item `42` saved and no warehouse has it in stock
- **THEN** `/favorites` has no row for item `42`: no leftover disabled `input.quantity`

```visual
route: /favorites
key: [data-testid="favorites-list"]
absent: input.quantity
```
