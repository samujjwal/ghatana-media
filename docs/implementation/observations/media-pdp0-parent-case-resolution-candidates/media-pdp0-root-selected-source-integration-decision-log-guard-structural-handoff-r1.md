# Cross-stage handoff: decision-log guard contract

**Classification:** BUILD/tooling handoff only; non-authoritative proposal. This is not a PDP-0 definition, owner decision, apply authorization, writer registration, or permission to change the guarded CAS implementation.

## Observed structural issue

The R9-R07 guarded application plan treats `.product-experience/decision-log.md` as one of seven exact raw preimage targets. Appending a source-owner, root-adoption, profile-registration, or apply-authorization decision section changes that whole-file hash. The decision section can be independently fingerprinted, but that section pin does not replace the whole-file CAS guard. Reusing the older whole-file pin after an append must therefore fail closed.

## Candidate contract for a separately authorized tooling change

An application plan could carry both bindings:

1. A `DECISION_SECTION` binding with the exact selector, a documented byte-range/anchor extraction algorithm, and the SHA-256 of the selected section bytes.
2. A `CAS_PREIMAGE` binding with the exact whole-file SHA-256 used by the seven-target guarded write.

Under the existing writer lease, a future writer could validate the authorized section and every target preimage, construct the append-only decision-log postimage in memory, verify the expected whole-file postimage, recheck all seven target preimages while holding the lease, then commit and read back the exact postimage. The journal would record both the section fingerprint and whole-file pre/postimage hashes. Any changed target, missing selector, ambiguous section, changed authorization record, or failed readback would abort without partial writes.

## Authority boundary and required decision

This proposal supplies no authority. A source owner and root authority would first need to approve an exact versioned contract and its schema, semantics, failure behavior, and tests. An authorized source-owner decision, root-adoption decision, independent review, and exact apply authorization would remain separate prerequisites. Until then, keep the current whole-file CAS behavior unchanged and do not append decision records under an old plan.
