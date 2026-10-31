## ADDED

### Requirement: Grid
#### Scenario: Grid shown
- **WHEN** the page opens
- **THEN** grid
```visual
route: /
component: Grid
viewports: 375, 1280
reference: design/a.png#0,10,200,300 @375
reference: design/b.png @>=768
key: [data-testid="grid"]
overlay: [role="dialog"]
expect: [data-testid="grid"] background-color ~ token:color-primary
expect: [data-testid="a"] left-with [data-testid="b"] @375
expect: [data-testid="a"] gap-to [data-testid="b"]
expect: garbage
ignore: a11y:
ignore: layout:key-missing
ignore-http: /x
ignore-http: /static/  # c
role: admin
redirects-to: login
absent: .x
state: empty-list
  do: fill [data-testid="s"] = 
  do: click! .menu
  do: hover .x
  do: storage k = v
  do: reload
  do: wait abc
  do: goto x
  do: fill! a = b
  key: [data-testid="empty"]
  expect: .a:nth-child(2) above .b
  route: /x
  bogus: 1
state: Bad
state: empty-list
not a field
```
#### Scenario:
```visual
key: x
```
### Requirement: Other
```visual
route: /a
  key: x
```
