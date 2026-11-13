# Document Intelligence release and migration runbook

**Scope:** the independently packageable DI module at `services/document-intelligence/` (MDI-002, PROPOSED).  
**State (2026-11-12):** the Media copy is **NOT the active deployment writer**. The existing Ghatana
`services/document-intelligence` deployment remains the only active writer until cutover is proven (section 7).
This runbook defines procedure; it records no executed deployment, no admitted provider, and no evidence that has not been
produced by an actual run. Where a step needs an artifact that does not exist yet, it says so.

## 0. Invariants

1. One gateway: `document-intelligence.v1` (`GET /v1/providers`, `POST /v1/parse`, `POST /v1/extract`, `POST /v1/embed`,
   generation-bound `DELETE /v1/operations/{id}`; `/healthz`, `/readyz`). No status GET is invented. After a lost
   acknowledgement or process restart the only truthful state is `UNKNOWN`.
2. One active writer per environment. Never start the Ghatana and the Media DI instance against the same
   model cache, temp root, queue/outbox, state or public endpoint. Media-side runs use isolated resources.
3. DI is released independently of Media audio/video: separate version, build, package, rollout and rollback. A DI outage
   or rollback never blocks Media upload/jobs/STT/TTS/video (verified by `npm run test:ocr-single-authority`).
4. Provider/model/rights admission is not implied by a release. Capability admission stays the worker's frozen
   registry (`capabilities/`, `profiles/`, `models/`); NOT_ADMITTED stays NOT_ADMITTED.

## 1. Package (independently)

| Artifact | Command (from repository root) | Notes |
| --- | --- | --- |
| Worker image/package | `cd services/document-intelligence && python deployment/build_package.py` and `docker build -f Dockerfile .` | Models are **referenced, not copied** (`models/*manifest*.yaml`); provision with `scripts/fetch_models.py` / `provision_increment4a_assets.py` into the offline bundle (`deployment/build_offline_bundle.py`). Inference never downloads models. |
| SBOM / vulnerability gate | `python deployment/sbom.py`, `python scripts/check_vulnerabilities.py` | Policy: `deployment/vulnerability-policy.v1.yaml`. |
| Java client | `./gradlew -p services/document-intelligence/clients/java test publishToMavenLocal` | Coordinates `dev.ghatana.documentintelligence:document-intelligence-java-client:<version>`; jar manifest carries `Ghatana-Contract-Version: document-intelligence.v1`. Remote publication/signing is a separate approved step (not performed here). |
| TypeScript client | `pnpm --filter @ghatana/document-intelligence-client build && pnpm pack` | Peer `@ghatana/document-extraction` at a Shared version compatible with `contracts/shared-contract.lock.json`; re-run `capture-shared-contract` when Shared's public API changes. |

Run the pre-package gates: Python `pytest` (see `TESTING.md`), Java client tests, TS client `vitest run`, and the shared-contract
lock test. Compare the result with the recorded baseline in `MIGRATION-MANIFEST.json` (`verification`); do not claim a pass that was not observed.

## 2. Deploy (progressive, one writer)

1. Confirm the target environment's current active writer (record it). Never deploy the second location as a writer.
2. Deploy the new revision in **shadow/parallel-isolated mode** (separate endpoint, separate model cache and temp root), `/readyz` must report READY.
3. Follow `deployment/activation.v1.yaml`: CANARY 5% -> EXPAND 25% -> HALF 50% -> FULL, promoting only when each stage's gates in
   `deployment/deployment-gates.v1.yaml` hold. Traffic switching is performed by the endpoint owner (Kernel provider binding / gateway), not by consumers.
4. Consumers bind only to the published client + Kernel facade; no consumer embeds a worker URL (inventory: `docs/migration/ocr-consumer-inventory.v1.json`).

## 3. Monitor

- Readiness: `/healthz` (liveness), `/readyz` (READY / DEGRADED / NOT_READY per `deployment/operational-envelope.v1.yaml`). DEGRADED serves only qualified surfaces.
- Metrics/labels: `config/observability-labels.v1.yaml` (bounded cardinality; `scripts/check_observability_cardinality.py`).
- Alert on the rollback triggers of the active activation stage: error rate, p95 latency, any DENIED capability served (admission violation), any unrecovered crash.
- Consumer-side: Media `scene-text-adapter` reports `OUTCOME_UNKNOWN` for ambiguous results; a rising UNKNOWN rate is a DI/transport signal, never a success.
- DI unavailability must show as OCR-only unavailability: Media upload/job/STT/video SLOs are tracked separately.

## 4. Roll back (independently)

Rollback is **authority reselection**, not state editing (`rollbackPlan` in `deployment/activation.v1.yaml`):
halt expansion; reselect the most recent earlier qualified revision; re-pin model/native assets to that bundle manifest; record the
rollback event and triggering metrics as evidence (never delete campaign evidence/receipts). Consumers are unaffected because the
wire contract and client versions are unchanged; in-flight operations whose acknowledgement is lost are reported `UNKNOWN` and retried idempotently with the same operation id/generation.
Rolling DI back never requires rolling Media back, and vice versa.

## 5. Scanner and other providers

The optional security-scanner provider has its own package, deployment and rollback; it is never a dependency of DI or of core Media.

## 6. Preconditions before the Media copy may become an active writer

- Architectural review has **accepted** MDI-002 (currently PROPOSED).
- `MIGRATION-MANIFEST.json` re-verified against the then-current Ghatana DI head (any drift since commit `7d81f267bc` re-copied and re-digested, or explicitly dispositioned).
- Immutable, signed or reproducible client packages published and installed-consumer tests passing (MED-09) - **not yet done**.
- Model assets provisioned with verified digests; rights/consent positions unchanged and recorded by their owners.

## 7. Cutover and retirement of the Ghatana DI (only after all four are proven)

| Gate | Required proof before the old deployment is retired |
| --- | --- |
| Source | Manifest digests match at the cutover commit; no un-migrated Ghatana-only change; conformance suites green in the new home. |
| Data | Model caches, runtime state, outbox/queue (if any) quiesced and migrated or provably empty; the old writer is stopped *before* the new writer starts (no overlap). |
| Consumers | Before/after canonical consumer inventory shows every consumer (Kernel adapter, Media scene-text, other products) bound to the published client/facade; zero missing consumers. |
| Endpoint | Authoritative endpoint/DNS/provider binding switched; old endpoint returns a controlled unavailable response; exactly one active writer confirmed by readiness and traffic evidence. |

Then: record approval, keep the previous deployment artifact available for a bounded rollback window, and only afterwards retire
the Ghatana DI sources/binaries. If any gate cannot be proven, the Ghatana deployment stays the writer.

## 8. If MDI-002 is rejected

Retain DI in Ghatana; consume the same published clients and Kernel facade from there; remove `services/document-intelligence/`
from Media in a follow-up using `MIGRATION-MANIFEST.json` to identify every added path. No product-visible contract change.
