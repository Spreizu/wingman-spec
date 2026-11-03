# Root-cause tracing

When the failure shows up deep in the stack, do not patch the leaf.

1. Name the bad value (path, id, nil, wrong status).
2. Walk callers until you find who created it.
3. Fix that creator, or the contract it broke.
4. Add a test at the creator, not only at the leaf.

A leaf guard is extra defence, not the fix.
