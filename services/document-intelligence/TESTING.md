# Testing

The test suite is split by trust boundary:

- `tests/contract`: strict v1 DTOs, exact keys, sanitized errors and multipart semantics.
- `tests/runtime`: deadlines, cancellation, bounded lanes, model registry, temp cleanup, health and safe logging.
- `tests/providers`: deterministic mapping and provider identity tests; real-provider tests are skipped when pinned assets are absent.
- `tests/adversarial`: malformed provider output, resource attacks, Unicode, process failure and diagnostic leak proofs.
- `tests/integration`: real local provider fixtures and frozen Shared conformance.

Provider-heavy tests run serially. Model provisioning is explicit and must happen before real-provider tests; inference never downloads models.

## Live provider authority preflight

With the worker running, compare its readiness and `/v1/providers` catalog to the frozen Increment-3 authority and write a reviewable diff artifact. The read-only `/v1/runtime-assets` endpoint reports verified content digests for the PaddleOCR asset roots admitted by the active authority — English and Nepali under the frozen Increment-3 runtime, and English, Nepali, Hindi, and Marathi under the `increment4a` profile — plus the readiness of internal dependencies such as Tesseract; it omits local filesystem paths and returns `not_ready` unless every admitted asset passes the worker's normal digest check.

```bash
uv run python scripts/verify_live_document_intelligence_authority.py \
  --url http://127.0.0.1:8765 \
  --output runtime-provider-authority-diff.json
```

The command exits `0` only when liveness, readiness, frozen-source fingerprint, and normalized provider records all match. It exits nonzero on mismatch, unavailable worker, or unavailable readiness. The default artifact path is `runtime-provider-authority-diff.json` in the current directory.

## Increment-3 authority gate

Run the owned preflight before the strict gate. It reports
`ENVIRONMENT_NOT_READY` when Python, pytest/provider dependencies, model
assets, or the runtime tool are unavailable; it never installs packages or
downloads model material.

```bash
uv run python scripts/preflight_increment3.py --json
uv run python scripts/verify_increment3.py --strict
```

The strict Increment-3 suite intentionally selects only Increment-3 contract,
runtime, provider, adversarial, and real-provider tests. Increment-4A office,
fallback, Tesseract, and language-qualification suites have separate gates and
must not invalidate the historical Increment-3 provider authority.

## Increment-4A reconciliation gate

`evaluation/increment4a/canonical-run.json` is the only canonical-run authority; result directory ordering has no meaning. The promoted-runtime tests load `profiles/increment4a.yaml` and verify both admission and rejection through the worker's own startup path — including transitive internal dependencies (Tesseract), so a missing fallback runtime reports `NOT_READY` rather than a hidden request-time failure. A successfully executed measurement test does not qualify a capability: every `REQUIRED` capability leaf must independently be `QUALIFIED`. Hindi and Marathi schema-guided extraction remain measured `NOT_QUALIFIED` leaves with `DEFERRED_TO_FUTURE_RELEASE` closure — recorded, unadmitted, and outside this increment's required set. JPEG fallback is `NOT_EVALUATED`: JPEG parses directly through PaddleOCR and the resilient route is not admitted for it.

The verifier also checks that the generated authority artifacts (`capabilities/increment4a.accepted.json`, `capabilities/increment4a.runtime-authority.json`) reproduce byte-for-byte from the canonical run plus frozen baseline (`generatedAuthoritiesCurrent`) and that the profile pins the committed runtime authority digest (`profileAuthorityPin`).
