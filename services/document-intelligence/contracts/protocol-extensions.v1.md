# document-intelligence.v1 — additive extension policy

`contracts/protocol-v1.md` is sealed. This document is the only place where
post-freeze, wire-visible additions are declared. It defines what may be added
without a new protocol revision and pins the exact rule consumers apply.

## Rules

1. **Strict-subset grammar is unchanged.** Request and response validators
   fail closed on undeclared keys. Consumers must NOT tolerate unknown
   optional fields: an undeclared key at any level of any envelope is a
   contract violation, not a hint to ignore.
2. **New optional fields are added only as declared keys in the extension
   registry below.** A field becomes admissible on the wire only after it is
   listed here with its carrier, type, and optionality. Declared extension
   keys are always optional; producers must emit documents that remain valid
   when every extension key is absent.
3. **Existing fields are never reinterpreted.** No declared or core key may
   change type, unit, encoding, cardinality, or semantics under any
   circumstance. `quality.warnings` entries are opaque strings; new warning
   tokens are additive and must use a registered `prefix:` token form.
4. **Incompatible changes require a new protocol revision.** A required field,
   a removed field, a narrowed enum, or a reinterpreted value is a new
   protocol (`document-intelligence.v2`), never an extension.
5. **Consumers gate extension consumption, not acceptance.** A consumer that
   does not implement an extension still validates the declared key's type
   (fail closed on malformed values) but derives no behavior from it.

## Extension registry

| Key / token                      | Carrier                              | Type   | Since | Semantics |
| -------------------------------- | ------------------------------------ | ------ | ----- | --------- |
| `workerCapabilityVersion`        | `GET /v1/providers` response (top level) | string | PROTO-04 | Declared worker capability revision. When present, clients validate it against their supported set (`WORKER_CAPABILITY_VERSIONS`) and reject incompatible workers with `INTERNAL_INVARIANT`. When absent, the worker is the pre-capability baseline and clients record `document-intelligence.v1-legacy`. |
| `officeRenderer:<name>`          | `quality.warnings[]` on parse output | string token | I4A | Names the office renderer (e.g. `soffice`) that produced the rendered input for an OOXML parse. Diagnostic only. |
| `pdfOcrAttemptLineage:<json>`    | `quality.warnings[]` on parse output | string token | I4A | JSON-encoded lineage of OCR attempts made by the hybrid-PDF strategy (per-region attempt order and outcomes). Diagnostic only. |
| `pageClassifications:<json>`     | `quality.warnings[]` on parse output | string token | I4A | JSON-encoded per-page scanned/digital classification emitted by the hybrid-PDF strategy. Diagnostic only. |
| `selectedProviderRef:<ref>`      | `quality.warnings[]` on parse output | string token | I4A | Provider ref selected by a composite/resilient strategy for the produced output. |
| `attemptedProviderRefs:<csv>`    | `quality.warnings[]` on parse output | string token | I4A | Ordered comma-separated provider refs attempted before selection by a resilient strategy. |

## Negotiation

`GET /v1/providers` is the negotiation point. `protocolVersion` is always the
constant `document-intelligence.v1`; `workerCapabilityVersion` (when declared
by the worker) distinguishes capability revisions inside that frozen protocol.
Clients record both values and refuse workers whose declared capability
version is outside their supported set. A worker that emits no
`workerCapabilityVersion` is treated as `document-intelligence.v1-legacy` —
admissible, with no capability-revision features assumed.
