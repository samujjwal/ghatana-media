# Increment 6 protocol authority

The machine-readable authority is the `protocolAuthority` section of
`evaluation/increment6/manifest.yaml`. It closes the worker-side I6 protocol
mapping without changing the frozen I3 wire artifacts.

| Task | Authority | Executable check |
| --- | --- | --- |
| I6-03 | Frozen `document-intelligence.v1` schemas and endpoint set | `protocolFreeze` |
| I6-04 | Canonical I3 request replay remains accepted/rejected with the frozen codes | `backwardCompatibility` |
| I6-05 | Optional extensions are registry-declared, additive, and versioned; incompatible changes require a new protocol revision | `additiveVersionedExtensions` |
| I6-06 | `GET /v1/providers` negotiates the worker capability revision; absent revision means the explicit legacy baseline | `negotiation` |

`scripts/verify_increment6.py` executes these checks directly. The focused
Python tests and TypeScript client tests remain separate evidence for the same
authority. The proof graph owns this protocol leaf and makes it a dependency
of `increment6.strictGate`; the leaf also depends on the sealed Increment-3
strict gate so protocol drift cannot be detached from the canonical baseline.

Missing binary-dependent I6 lanes are intentionally not qualification evidence.
Their capability dimensions stay `DEFERRED_TO_FUTURE_RELEASE`, their fixture
leaves stay `NOT_RUN`, and an absent fixture-dependent leaf with `PASS` status
is a strict verification error. Page-facts and declared-negative lanes are
explicitly marked as non-binary qualification inputs and are not widened by
this rule.

Focused verification:

```bash
.venv/bin/python scripts/verify_increment6.py --strict
.venv/bin/pytest tests/contract/test_increment6_protocol_authority.py \
  tests/contract/test_protocol_v1.py \
  tests/contract/test_i3_canonical_requests.py
pnpm --dir clients/typescript test -- \
  tests/protocol.test.ts tests/providers-catalog.test.ts
```

These checks are authority and contract checks only. Provider execution,
load, soak, and chaos campaigns are not part of this pass.
