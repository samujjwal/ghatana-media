# PDP-1 Canonical Domain and Data Model

**Product:** Media (`media`)
**Artifact:** `media.pdp-1.domain-data.v1`
**Status:** proposed canonical registries; bounded PXD-026 state policies and the six PXD-035 PDP-0 rule mappings have explicit limits; full PDP-1 semantic acceptance and independent P0-010 remain open

This directory organizes domain and data semantics recorded in PDP-0 into
machine-readable registries. PDP-0 remains the source for product truth and
policy. Runtime contracts, TypeScript types, OpenAPI, protobuf, migrations,
and publishers are evidence of implementation or compatibility surfaces;
their shapes do not become canonical domain meaning by appearing here.

## PDP1-001 source-grounded reconciliation (proposed)

This reconciliation was prepared against the current checkout. Counts below
are inventory counts, not completeness or semantic-acceptance claims.

| Named source class | Inspected sources and exact inventory | What the source establishes; what it does not |
| --- | --- | --- |
| PDP-0 domain model | `.product-experience/pdp-0-product-truth/domain-model.yaml` (1 registry; 20 proposed catalog entries under `proposedRecordCatalog`) and referenced `state-models.yaml` | PDP-0 identifies proposed responsibilities/lifecycle boundaries and says PDP-1 is the destination; it explicitly remains proposal material. It does not supply accepted object keys or implementation parity. |
| Runtime contracts | `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java` (1 primary contract source; 12 enums, 17 records, 7 interfaces) | Observed Java records include governance/consent, upload request/session, artifact, job request/job/lease, stream request/session/frame/ack. Generic maps and Java types do not define product meaning or cross-interface identity. |
| TypeScript package | `libs/audio-video-types/src/contracts.ts` (1 primary contract source; currently 20 exported types and 21 schemas; package also has `src/index.ts`, `src/index.d.ts`, and tests) | Observed schemas cover artifact, upload session, operation/job, provider capability, transcription, synthesis, voice training/conversion, multimodal requests/results, and a raw machine-scoped job-state observation. This generation differs from Java and must not be selected as canonical by presence. The observation preserves legacy state uncertainty; its role catalog is not runtime or wire parity. |
| OpenAPI | `contracts/openapi/media.yaml` (OpenAPI 3.1.0, version 1.3.0; 27 path/method operations) | The spec exposes health, consent, upload/artifact, job, stream, and provider surfaces; several schemas are permissive (`additionalProperties: true`). It is an API projection, not a complete domain registry. |
| Protobuf | Four service files: `modules/speech/stt-service/src/main/proto/stt_service.proto`, `modules/speech/tts-service/src/main/proto/tts_service.proto`, `modules/vision/vision-service/src/main/proto/vision_service.proto`, `modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto` (4 services; 43 RPC declarations; 109 message declarations and 9 enum declarations) | Observed speech, transcript/word timing, voice/profile, vision detections/boxes/frames, and multimodal results. Names and shapes are service-specific. Millisecond-suffixed fields are observations; no shared artifact-version, scene, or domain identity follows from them. |
| Persistence models and migrations | Legacy JPA `AudioFileEntity.java` and `TranscriptionEntity.java` (2 entities); `modules/infrastructure/persistence/src/main/resources/db/migration/V1__init_schema.sql` (2 tables); `providers/aws-postgresql/src/main/resources/db/media-runtime/V001__media_runtime_state.sql` (5 tables) plus V002–V006 (5 migrations) | Storage currently represents audio files/transcriptions and runtime upload/chunk/artifact/job/stream/consent state. Keys, unique constraints, integer epochs, status checks, and soft-delete/version columns are storage mechanics; they do not settle domain cardinality, canonical version identity, or lifecycle meaning. |

### Coverage and reconciliation findings

The current registries contain **39 domain-object records, 13 value-object
records and 11 proposed relationship records**. PXD-058 and PXD-062 supply
bounded canonical caption/transcript version definitions; their runtime
materialization and independent acceptance remain unqualified. The domain catalog intentionally combines PDP-0 proposed concepts
with observed runtime projections; it does not mean all listed concepts exist
in code. Seven
additional source-visible record families are now called out in
`domain-objects.yaml` as observed-only candidates: upload session, upload
chunk, stream session, stream frame, consent record/decision, persisted audio
file, and transcription. No canonical relationship/cardinality is inferred
from their storage keys or method signatures.

`media.domain.caption-version` has bounded immutable identity, typed parent
and registration semantics under PXD-058. Its local simulation projection
remains synthetic, not an observed runtime or persistence record.
`media.domain.transcript-version` defines the canonical immutable transcript
identity required by existing inspection and caption-parent contracts under
PXD-062. Legacy transcription UUIDs and provider result IDs do not establish
that identity. Missing timing is inspectable; qualified clock mapping is
separate read-context evidence. Registration and content approval are separate,
and no producer, native Lifecycle receipt or full phase acceptance is admitted.

The following crosswalk records only what the cited implementation or
persistence sources expose. “Not applicable” means that source family was not
used to establish the candidate observation; it is not evidence that the
concept cannot exist. These remain observed-only candidates, not canonical
domain objects.

| Observed-only candidate | Runtime contracts | TypeScript | OpenAPI | Protobuf | Persistence models/migrations |
| --- | --- | --- | --- | --- | --- |
| Upload session | `MediaRuntimeContracts.java#UploadSession` | `contracts.ts#UploadSession` | `media.yaml#/components/schemas/UploadSession` | Not applicable to the cited observation | `V001__media_runtime_state.sql#media_upload_sessions` |
| Upload chunk | Not applicable to the cited observation | Not applicable to the cited observation | Not applicable to the cited observation | Not applicable to the cited observation | `V001__media_runtime_state.sql#media_upload_chunks` |
| Stream session | `MediaRuntimeContracts.java#StreamSession` | Not applicable to the cited observation | `media.yaml#/components/schemas/StreamSession` | Not applicable to the cited observation | `V001__media_runtime_state.sql#media_stream_sessions` |
| Stream frame | `MediaRuntimeContracts.java#StreamFrame` | Not applicable to the cited observation | Not applicable to the cited observation | `stt_service.proto`; `vision_service.proto` (service-message projections only) | Not applicable: no durable frame record observed in the listed migrations |
| Consent record/decision | `MediaRuntimeContracts.java#ConsentDecision` | Not applicable to the cited observation | `media.yaml#/components/schemas/ConsentRecord` | Not applicable to the cited observation | `V003__media_consent_authority.sql#media_consents` |
| Persisted audio file | Not applicable to the cited observation | Not applicable to the cited observation | Not applicable to the cited observation | Not applicable to the cited observation | `AudioFileEntity.java`; `V1__init_schema.sql#audio_video.audio_files` |
| Transcription | Not applicable to the cited legacy-record observation | `contracts.ts#TranscriptionResult` | Not applicable to the cited observation | `stt_service.proto#Transcription` | `TranscriptionEntity.java`; `V1__init_schema.sql#audio_video.transcriptions` |

The exact paths and record-level references are in the corresponding
`sourceRefs` of `domain-objects.yaml`. This is a source-family trace, not a
claim that every projection is equivalent or that an absent projection is
unsupported.

Important omissions and conflicts to resolve before semantic acceptance:

- Java runtime, TypeScript, OpenAPI, protobuf, and persistence use different
  names, fields, keys, and status vocabularies. Examples include Java
  `artifactId`/`sizeBytes`/`sha256`, TypeScript `id`/`sizeBytes`/
  `checksumSha256`, the permissive OpenAPI component, and persistence
  tenant-scoped artifact IDs. Existing APIs are not adjudicated here.
- Processing-job projections differ: current Media Java and PostgreSQL use
  `ACCEPTED`, `RUNNING`, `OUTCOME_UNKNOWN`, `COMPLETED`, `FAILED`, and
  `CANCELLED`; the current SQL status constraint was widened by V007 to retain
  unknown outcomes. TypeScript includes `QUEUED`, `RETRY_PENDING`,
  `OUTCOME_UNKNOWN`, `RECONCILING`, and `PARTIALLY_SUCCEEDED`; PDP-0 has
  separate job/attempt machines. No cross-generation winner or conversion is
  selected, and `ACCEPTED` does not establish durable queueing.
- Project/revision, asset, recipe, processing graph, resolved plan, run,
  checkpoint, scene/animation/simulation, timeline, quality assessment,
  render/delivery outcome, and provenance concepts are PDP-0 proposals with
  no matching record established by the named implementation schemas.
- `ArtifactVersion` remains a proposed domain distinction, not an observed
  separate runtime record. Runtime artifact digest/version keys, content
  deduplication identity, project revision identity, transcript ancestry, and
  derived-artifact lineage are not reconciled across consumers.
- Runtime/OpenAPI use Java instants, ISO strings, or numeric storage epochs;
  TypeScript has ISO timestamp and `durationMs` fields; protobuf includes
  `timestamp_ms`, `duration_ms`, and STT `start_ms`/`end_ms`; legacy
  persistence includes `duration_seconds` and timestamps with time zone.
  These do not define a universal time base, precision, epoch, or conversion.
- Numeric audio sample-rate/channel/bit-depth, scalar video FPS, and numeric
  bounding-box coordinates occur in implementation contracts. Origin,
  orientation, dimensions association, pixel aspect, frame mapping, sample
  format/layout, rational/VFR time base, and physical-unit registry are not
  consistently bound. No defaults or coordinate/frame/unit semantics are
  selected by this reconciliation.
- Persistence `audio_file_id` and tenant-scoped primary/unique keys evidence
  storage constraints only. Domain cardinalities for project assets, revisions,
  artifacts, jobs, outputs, consent, transcript versions, lineage, and
  ownership remain owner decisions; the proposed relationship records remain
  proposals.

### Unresolved owner-bound decisions

Media domain owner: approve object boundaries, canonical identities/version
keys, lifecycle meanings, project/artifact/transcript lineage, and proposed
relationship/cardinality semantics. API/SDK/protobuf consumer owners: approve
cross-generation compatibility mappings and version/deprecation treatment.
Platform storage owner: confirm persistence guarantees and physical deletion
semantics; identity owner: confirm principal/tenant identity authority. Scene
model and unit-registry owners: determine coordinate systems, physical units,
and conversion contracts. Independent P0-010 reviewer: separately assess
semantic acceptance. Until those decisions are recorded, IDs and lifecycle
rules in these registries are proposals, observed shapes remain observations,
and conflicts/unknowns must not be silently normalized.

Media owns media-specific product meaning. Platform services own their generic
identity, workflow mechanics, privileged effects, inference, audit, event
transport, and storage mechanics. Registries distinguish observed interfaces
from proposals and unresolved mappings. They remain subject to Media owner
review and independent P0-010 acceptance.

An unaccepted PDP-0 lifecycle proposal separates authored specifications,
resolved plans, mutable run/attempt progression, and proposed artifact
versions. Proposed project revisions reference proposed artifact versions;
the inspected runtime does not establish canonical artifact-version identity,
immutable source bytes, durable attempt history, or complete ancestry. Access, rights,
consent, retention, locality, and erasure are separate policy dispositions.
Scene, animation, simulation/model, editorial timeline, and wall-clock state
use separate owners and clocks.

| File | Contents |
| --- | --- |
| `domain-objects.yaml` | Entity/object catalog and lifecycle boundaries |
| `value-objects.yaml` | Typed values, units, time bases, uncertainty and fidelity |
| `relationships.yaml` | Explicit references and ownership/cardinality constraints |
| `operations.yaml` | Domain operations and observed UI/action/API/gRPC/CLI/SDK/tool/event families |
| `states.yaml` | Proposal-only machine/state inventory extracted without accepting PDP-0 meanings |
| `transitions.yaml` | Proposal-only transition relations, preserving PDP-0 source machine boundaries |
| `events.yaml` | Event envelope evidence, exact lifecycle-publisher observations, separate local client-listener notifications, and unresolved taxonomy/contract boundaries |
| `evidence.yaml` | Evidence classes, quality/uncertainty and finality constraints |
| `provenance.yaml` | Lineage, derivation, versions and source references |
| `privacy.yaml` | Classification, consent, access, retention and erasure semantics |
| `versioning.yaml` | Proposed versioning boundaries, observed runtime version fields, and unresolved compatibility |
| `offline-sync.yaml` | Offline operation and reconciliation constraints |
| `interoperability.yaml` | Interface projections and unresolved mappings |
| `authority.yaml` | Domain and platform authority boundaries |
| `decisions.yaml` | PDP-0 rules and owner decisions still required |
| `canonical-reconciliation.yaml` | Source-grounded identity, version, tenancy, cardinality and history adjudication for material domain concepts; unresolved decisions remain explicit |
| `state-adjudication.yaml` | Machine-qualified state meaning proposals and exact conflict dispositions; no source spelling is silently normalized |
| `presentation-projections.yaml` | Host-neutral read projections with freshness, uncertainty, authorization scope and host-supplied actions |
| `action-contracts.yaml` | Host-neutral operation outcome envelope and finality distinctions; transport mappings remain unresolved |

### PDP1-01 through PDP1-05 reconciliation

`canonical-reconciliation.yaml` adjudicates the identity and lifecycle
dimensions for projects, artifact versions, uploads, jobs and attempts, stream
sessions, transcripts and captions, outputs, consent and rights, quality,
provenance, and delivery. It records implementation keys separately from
proposed domain identity. Tenant-qualified database keys, digest uniqueness,
aggregate version counters, and identifier lists are not promoted into global
identity, immutable artifact version, append-only history, or ancestry rules.
The unresolved owner decisions at the end of that file are acceptance gates,
not omissions to fill from whichever projection happens to be newest.

`state-adjudication.yaml` preserves exact job/attempt/delivery identity and the
`RETRY_PENDING`/`RETRYING`, `CANCEL_REQUESTED`/`CANCELLING`, and
unknown/reconciliation/partial-success distinctions. PXD-026 explicitly
accepts the bounded policy decisions linked there through
[`../acceptance.yaml`](../acceptance.yaml) dispositions
`MEDIA-OWNER-20261007-04` through `-07`; that does not accept each state
projection, transition, runtime mapping, or the PDP-1 phase. Existing lossy
adapter mappings remain implementation evidence only.

`operations.yaml` remains the semantic operation center. The added
`../interface-parity/operation-parity.yaml` records the current source
denominators across UI actions, HTTP, gRPC, CLI, SDK, Agent Tools, and events.
It distinguishes proposed family associations from accepted bindings and
keeps unsupported equivalence unresolved. `action-contracts.yaml` provides
host-neutral request outcomes; it does not assert that a transport implements
every outcome. `presentation-projections.yaml` defines read-side fields and
requires freshness, uncertainty, authorization scope, and safe actions to be
carried from the host/domain adapter.

The current operation-parity report inventories 284 identities across eight
surface families: 146 UI actions, 27 HTTP operations, 43 gRPC methods, CLI,
SDK, Agent Tools, events, and related interfaces. It reports 192 unresolved
identities and zero owner-accepted bindings. Proposed family associations do
not eliminate source-specific gaps or establish semantic equivalence.

## Uncertainty and finality

The following is source material only: PDP-0 `state-models.yaml` proposes
unknown/finality distinctions, cancellation request versus confirmation, and
machine-specific state relations. PDP-1 extracts exact machine IDs, dimensions,
state spellings, and transition relations into `states.yaml` and
`transitions.yaml`; this extraction does not accept the per-record source
mappings, guards, transition legality, or terminality. PXD-026 accepts the
bounded non-equivalence rules for `RETRY_PENDING`/`RETRYING`,
`CANCEL_REQUESTED`/`CANCELLING`, ingress `ACCEPTED`/job `QUEUED`, and unknown
outcomes; exact source-to-canonical mappings and the job, attempt, and delivery
uses of `OUTCOME_UNKNOWN`, `RECONCILING`, and `PARTIALLY_SUCCEEDED` remain
unresolved. The current TypeScript
`CANCELLING` to `RUNNING` mapping is recorded as a lossy historical
implementation observation, not adopted as product or presentation meaning.
The local TypeScript compatibility helper now preserves `CANCELLING` and
`RETRYING` as raw, machine-scoped observations with null canonical state, and
rejects unsupported runtime inputs. Its typed role catalog records the new
observation schema/type; this is source-role evidence only, not runtime-current
proof or cross-interface parity. The sibling Data Cloud adapter still maps
`RETRYING` to `RUNNING` and `BLOCKED`/`REQUIRES_REVIEW` to `FAILED`; that change
requires its external owner. OpenAPI's
`PlatformOperation.state` enum is narrower and differently named; no mapping
is inferred. No matching lifecycle state enum was found in the inspected active
Media protobuf service files; that absence is not a support decision.

No React component, TypeScript type, OpenAPI schema, protobuf declaration,
Java enum, or runtime adapter independently defines product state. A
presentation-only mapping may be added only as an explicitly labeled proposal
in `states.yaml`, with exact source and display context, rationale, and owner;
the current extraction adds no such mapping because the observed mappings are
conflicting or lossy. Transition operation references use only existing
PDP1-002 operation-family IDs and remain proposed/unresolved. Event triggers,
permissions, execution effects, operation equivalence, and individual source
mappings remain pending their respective owners and PDP1-004. No implementation
or API schema was changed by this extraction.

## Acceptance

PDP1-001 reconciliation and the canonical registries remain proposals. The
bounded PXD-026 policies do not accept per-record identities, all state or
operation bindings, exact wire parity, consumer compatibility, unit/coordinate
decisions, event names, or offline conflict behavior. The prerequisite is
independent P0-010 acceptance; PDP-1 review then requires `media-domain-lead`,
`distributed-systems-lead`, `privacy-and-rights-owner`, relevant domain and
platform contract owners, and an independent product-definition reviewer.
The active record is `ACCEPT-INPUT-PDP-1` in
[`../acceptance.yaml`](../acceptance.yaml). Structural validity does not
establish runtime behavior, qualification, publication, or phase acceptance.

## Authority, dependencies, artifact registry, and proof

PDP-0 `domain-model.yaml` and `state-models.yaml` remain upstream product-truth
sources; bounded state-policy references are recorded in
[`state-adjudication.yaml`](state-adjudication.yaml). The full PDP-1 artifact
set is indexed in [`../source-manifest.yaml`](../source-manifest.yaml) and
[`../artifact-identities.yaml`](../artifact-identities.yaml). This directory's
registries are `domain-objects.yaml`, `value-objects.yaml`, `relationships.yaml`,
`operations.yaml`, `states.yaml`, `transitions.yaml`, `events.yaml`,
`evidence.yaml`, `provenance.yaml`, `privacy.yaml`, `versioning.yaml`,
`offline-sync.yaml`, `interoperability.yaml`, `authority.yaml`,
`decisions.yaml`, `canonical-reconciliation.yaml`, `state-adjudication.yaml`,
`presentation-projections.yaml`, and `action-contracts.yaml`; cross-surface
identity inventory is in [`../interface-parity/operation-parity.yaml`](../interface-parity/operation-parity.yaml).

The decision and dependency sources are
[`../decision-log.md`](../decision-log.md),
[`../acceptance.yaml`](../acceptance.yaml),
[`../authority-map.yaml`](../authority-map.yaml),
[`../traceability.yaml`](../traceability.yaml), and
[`../gaps.yaml`](../gaps.yaml). Local verification uses
`tests/product-definition-authority.test.mjs`,
`tests/media-contract-parity.test.mjs`,
`pnpm check:product-definition-authority`,
`pnpm check:product-experience-local`, and
`node ../../scripts/report-media-definition-residuals.mjs`. These are
structural and source-inventory checks; independent P0-010/PDP-1 review and
Lifecycle currentness/receipts remain unperformed.

### Local structural verification (not portable CI evidence)

On the workstation used for this review, Python 3 with PyYAML 6.0.3 is
available. The following repository-root command parses the three PDP1-001
registries, checks that every relationship endpoint resolves to a declared
domain-object ID, and validates fragments on references to PDP-0 YAML files
against their actual mapping keys and record `id` values. References to
non-YAML source symbols remain source observations and are not interpreted as
YAML fragments. This checks structural/reference integrity only; it does not
infer semantics or establish acceptance.

```sh
python3 - <<'PY'
from pathlib import Path
import yaml

root = Path.cwd()
base = root / ".product-experience/pdp-1-domain-data"
objects = yaml.safe_load((base / "domain-objects.yaml").read_text())
values = yaml.safe_load((base / "value-objects.yaml").read_text())
relationships = yaml.safe_load((base / "relationships.yaml").read_text())
object_ids = {record["id"] for record in objects["objects"]}
value_ids = {record["id"] for record in values["values"]}
relationship_ids = set()
errors = []

def collect_yaml_keys_and_ids(value, found):
    if isinstance(value, dict):
        for key, child in value.items():
            found.add(str(key))
            if key in ("id", "modelId", "key") and isinstance(child, (str, int, float)):
                found.add(str(child))
            if key == "observedRecords" and isinstance(child, list):
                found.update(str(record_id) for record_id in child)
            collect_yaml_keys_and_ids(child, found)
    elif isinstance(value, list):
        for child in value:
            collect_yaml_keys_and_ids(child, found)

def source_refs(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "sourceRefs":
                refs = child if isinstance(child, list) else [child]
                for ref in refs:
                    if isinstance(ref, str):
                        yield ref
            yield from source_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from source_refs(child)

parsed = {
    "domain-objects.yaml": objects,
    "value-objects.yaml": values,
    "relationships.yaml": relationships,
}
for registry_name, registry in parsed.items():
    for ref in source_refs(registry):
        path, separator, fragment = ref.partition("#")
        if not separator or not path.startswith(".product-experience/pdp-0-product-truth/"):
            continue
        source_path = root / path
        if source_path.suffix not in (".yaml", ".yml"):
            continue
        if not source_path.is_file():
            errors.append(f"{registry_name}: missing PDP-0 YAML source {path}")
            continue
        source_doc = yaml.safe_load(source_path.read_text())
        valid_fragments = set()
        collect_yaml_keys_and_ids(source_doc, valid_fragments)
        if fragment not in valid_fragments:
            errors.append(f"{registry_name}: unresolved PDP-0 YAML fragment {path}#{fragment}")

for relation in relationships["relationships"]:
    rid = relation["id"]
    if rid in relationship_ids:
        errors.append(f"duplicate relationship id: {rid}")
    relationship_ids.add(rid)
    for side in ("from", "to"):
      endpoints = relation[side] if isinstance(relation[side], list) else [relation[side]]
      for endpoint in endpoints:
        if endpoint not in object_ids:
          errors.append(f"{rid}: unresolved {side} domain-object reference {endpoint}")
if errors:
    raise SystemExit("reference check failed:\\n" + "\\n".join(errors))
print(f"PASS: parsed 3 PDP1-001 YAML registries; {len(object_ids)} domain objects, "
      f"{len(value_ids)} value objects, {len(relationship_ids)} relationships; "
      "relationship endpoints and PDP-0 YAML fragments resolve")
print(f"Parser: PyYAML {yaml.__version__}; Python {__import__('sys').version.split()[0]}")
PY
```

This command depends on the workstation's already-installed PyYAML and is not
a portable CI check or a newly declared project dependency. It is local
structural evidence only; the focused project authority/local checks and
`git diff --check` are separate checks.

### PDP1-003 state/transition extraction verification

For the proposal extraction, use duplicate-key-safe PyYAML parsing on
`pdp-0-product-truth/state-models.yaml`, `pdp-1-domain-data/states.yaml`, and
`pdp-1-domain-data/transitions.yaml`. Reconcile each of the eleven source
`modelId` records against its extracted machine ID, status dimension, and exact
state-ID sequence; then compare each nonempty source transition list
positionally against `transitionRecords` grouped by `sourceMachineId`. Verify
that source and extracted machine/state/transition counts agree, that the one
source machine with no state list remains empty, and that every transition
endpoint belongs to its own extracted machine. Check cross-source conflicts
and mappings as unresolved proposals, not semantic approvals. This is a local
structural/provenance check only; it does not verify runtime behavior, select a
canonical projection, accept meanings, or establish phase completion.
