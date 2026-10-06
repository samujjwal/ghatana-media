# Ghatana Media

This repository is the standalone destination for Ghatana's multimodal media
runtime, clients, contracts, tests, fixtures, and product-owned operations
material. It is being prepared from `ghatana/services/media` under the
[expert-reviewed migration plan](docs/migration/expert-reviewed-master-plan.md).

Start with the [documentation overview](docs/README.md), [vision](docs/VISION.md),
[requirements](docs/REQUIREMENTS.md), [design](docs/DESIGN.md), and
[examples](docs/EXAMPLES.md). The user's Four-Phase Product Definition Hardening
Plan governs the minimum completion requirements and ordered tasks recorded in
the requirements document.

## Intended consumers and non-goals

Consumers include product and runtime owners, integrating products, HTTP/gRPC
callers, SDK and embedded UI consumers, and reviewers using the local Explorer.
Web, production CLI, agent-tool, event, and system integration experiences need
their own admitted contracts. Media does not own generic identity, model routing,
Document Intelligence, Data Cloud read models, platform event delivery, or
privileged effect authority. Archived desktop apps are outside the active scope.

## Quick usage

With Node.js and the declared `pnpm@10.33.0` available, run these read-only local
checks from the repository root:

```sh
pnpm check:product-experience-local
pnpm test:product-experience-local
```

They check the existing local model and reference denominators. Four-phase
completeness and acceptance require the broader checks in
[TESTING](docs/TESTING.md) and owner-native [EVIDENCE](docs/EVIDENCE.md).
See [EXAMPLES](docs/EXAMPLES.md) for the fixture CLI and browser preview.

## API / config / contracts

The present HTTP wire source is [OpenAPI](contracts/openapi/media.yaml), compared
with the committed [route manifest](config/route-manifest.json). Speech, vision,
and multimodal protobufs live with their owning modules. The complete family
inventory and exact paths are in [docs/README.md](docs/README.md).
Runtime configuration and its local defaults are documented in
[OPERATIONS](docs/OPERATIONS.md); the runtime is disabled by default. There is no
aggregate `service-contract.yaml`: CLEAN-2/GAP-06 selects the source-specific
OpenAPI, route-manifest, protobuf, and provider-manifest authorities. Existing
wire source still does not settle the canonical PDP-1/PDP-3 operation model.

## Migration status

The files here are a migration-preparation copy. The source Media service
remains canonical until a reviewed parity report and cutover manifest satisfy
the migration gates. This checkout is not yet an independently buildable or
qualified runtime: its current Gradle settings and several dependency contracts
still rely on Ghatana workspace projects ([GAP-02](.product-experience/gaps.yaml)).

The accepted product-definition scope remains the migration-specific PDP-0
boundary slice. The four canonical PDPs now have source registries for Product
Truth, Domain/Data, Design/Interfaces, and complete Product Experience. The
Explorer is a projection outside those phases. The local simulation includes
synthetic project, upload, verification-job, and transcription states; acceptance
gates remain pending, and owner/native evidence still must be admitted. None of
these proposals claims runtime availability, qualification, licensing, or production readiness. Current
source, path, and consumer records are under [`migration/`](migration/) and
[`.product-experience/`](.product-experience/).

## Product boundary

Media owns media-specific artifact and job semantics, streaming, speech, vision,
multimodal processing, consent and lifecycle behavior, and provenance. The
general OCR and Document Intelligence runtime is a Ghatana platform service at
`ghatana/services/document-intelligence`; it is excluded from the intended
product transfer. Prepared `OcrService` and `KernelOcrProviderAdapter` code still
contradict this boundary and require PDP0-003/IMP-01 reconciliation. Shared
remains the owner of `@ghatana/documents` and
`@ghatana/document-extraction`. Media may consume the public Document
Intelligence API for temporal and scene-text semantics while keeping those
semantics on the Media side.

Data Cloud remains the owner of its media read models and consumer integrations.
This repository does not claim ownership of Data Cloud implementation code,
runtime activation, data handover, model admission, or production qualification.

## Runtime documentation

The transferred source documentation describes the Media runtime and its
existing local and internal-preview capabilities. Those instructions are not
currently a standalone build or deployment guarantee for this repository.

- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Testing](docs/TESTING.md)
- [Privacy and retention policy](docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md)
- [Repository boundary](BOUNDARY.md)

## Product experience work

The local [Media Experience Explorer](apps/media-experience-explorer/README.md)
and its deterministic simulation support artifact-intake scenarios and one
transcript/caption workflow. The target phases are PDP-0 Product Truth, PDP-1
Canonical Domain & Data Model, PDP-2 Design Language & Interface System, and
PDP-3 Complete Product Experience. Explorer is a projection outside those phases.
The canonical product-definition tree is `.product-experience/pdp-0-product-truth/`
through `pdp-3-product-experience/`, with `.product-experience/explorer/` outside
the PDP phases. The generated source manifest and surface registry are the
cross-phase indexes; acceptance limits and gaps are tracked under
[`.product-experience/`](.product-experience/).

## Repository layout

Runtime modules and providers are at the repository root, with shared runtime
contracts under `runtime-contracts/`. Older desktop applications are preserved
under `archive/media-desktop-apps/` for archival review; they are not represented
as active product capabilities.
