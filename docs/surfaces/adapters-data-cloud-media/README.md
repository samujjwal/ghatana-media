# Surface: `adapters-data-cloud-media`

Optional Data Cloud integration boundary (`adapters/data-cloud-media`,
Java/Gradle). Data Cloud is a downstream consumer of governed Media
metadata — it never owns Media artifacts, uploads, jobs, attempts,
streams, consent, processing results, or finality, and a Data Cloud outage
must not change canonical Media state.

## Responsibility

- `DataCloudSttAdapter`, `DataCloudVisionAdapter`,
  `DataCloudMultimodalAdapter` — compatibility implementations of Data
  Cloud's `MediaProcessorPort`. All three currently report **unavailable**
  for every operation; legacy calls fail closed (or return `null` for
  unsupported operations). Constructing an adapter admits no provider work.
- `MediaObservationPublicationCoordinator` — source-side publication seam
  with injected publication client, live source authority and durable
  outbox. The default outbox claim is unavailable; no installed Data Cloud
  public client or real destination receipt/readback is wired, so local
  fixtures do not prove a platform effect.
- `MediaSemanticObservationProjector` — validates and bounds a proposed
  semantic projection. Its references are not authenticated by projection
  and it does not authorize disclosure or publication.

## Public operations

| Class | Role |
| --- | --- |
| `DataCloudSttAdapter` (`com.ghatana.stt.datacloud`) | STT `MediaProcessorPort` compatibility adapter — unavailable |
| `DataCloudVisionAdapter` (`...vision.datacloud`) | Vision `MediaProcessorPort` compatibility adapter — unavailable |
| `DataCloudMultimodalAdapter` (`...multimodal.datacloud`) | Multimodal `MediaProcessorPort` compatibility adapter — unavailable |
| `MediaObservationPublicationCoordinator` | Bounded publication seam; outbox claim fails closed by default |
| `MediaSemanticObservationProjector` | Validates/bounds proposed semantic projections only |

## States and invariants

- The adapter surface has **no Media job-state mutation API**; Media
  retains job and processing finality.
- An ambiguous downstream publication remains unresolved at the
  publication boundary — never promoted to job success or failure.
- Optional-consumer rule: metadata projection never owns Media
  job/artifact finality; absence of Data Cloud changes nothing canonical.

## Dependencies and configuration

- Data Cloud public ports (`MediaProcessorPort`) via `api` dependency;
  publication client, source authority and outbox are injected — no
  production wiring ships in this module.

## Errors

Adapters report unavailability rather than throwing fabricated results;
publication claim failures stay at the publication boundary; projector
rejects unbounded/invalid proposals.

## Tests and commands

```bash
./gradlew :services:media:adapters:data-cloud-media:test
```

Coverage targets installed-public-port behavior, version/digest mapping,
permission denial, lag/retry/duplicate-event handling, outage isolation
and the no-second-writer invariant. Tests use local fixtures and do not
prove a real Data Cloud platform effect.
