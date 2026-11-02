# favorites

## Purpose
Favorites keep the items a person wants to find again, with what each item costs and whether it can be ordered.

## Requirements

### Requirement: List shows availability
The favorites list SHALL show each saved item with its stock and price.
Why: The shopper wants to see at a glance what can be ordered, so that they do not open each item.

#### Scenario: Available item shows an add button
- **WHEN** the shopper has item `42` saved and it is in stock
- **THEN** `/favorites` shows one row for item `42` with an enabled `[data-testid="favorite-add"]`

```visual
route: /favorites
key: [data-testid="favorites-list"]
key: [data-testid="favorite-add"]
```

#### Scenario: Unavailable item shows a disabled row
- **WHEN** the shopper has item `42` saved and no warehouse has it in stock
- **THEN** `/favorites` shows the row for item `42` with a disabled `input.quantity` and no price

```visual
route: /favorites
key: [data-testid="favorites-list"]
state: unavailable
  do: wait 100
  do: click button.modal-close
  key: input.quantity[disabled]
```

### Requirement: Header heart
The header SHALL show a heart that opens the favorites list.
Why: The shopper wants to reach saved items from every page, so that they do not search again.

#### Scenario: Heart shows in the header
- **WHEN** any page opens
- **THEN** the header shows `[data-testid="favorites-heart"]`

```visual
route: /favorites
key: [data-testid="favorites-heart"]
```
