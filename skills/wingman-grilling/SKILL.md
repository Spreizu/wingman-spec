---
name: wingman-grilling
description: >
  Loaded by /spec-explore. Grill the user in rounds until the design tree has
  no open questions. Do not act until they confirm a shared understanding.
license: MIT
---
# Grilling

Map the work as a design tree: every decision branches into the decisions that hang off it. Work in rounds.

The **frontier** is every decision whose prerequisites are already settled. Ask the whole frontier in one round. Number each question and give your recommended answer. Word each question so "yes" accepts that answer. Then wait.

```
**Q1** - **<title>**: <body, with choices>

Recommended: <your answer>
```

Each round of answers pushes the frontier out. A question that depends on another still open in this round belongs to a later round.

Finding facts is your job. Dispatch a sub-agent for filesystem or code facts. Do not ask the user for anything you can look up. Decisions stay with the user.

Stop when the frontier is empty. Do not implement until the user confirms you have reached a shared understanding.

Copyright (c) mattpocock/skills. MIT. Rewritten for wingman-spec.
