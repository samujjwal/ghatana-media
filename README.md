# Ghatana Media

This repository is the standalone destination for Ghatana's multimodal media
runtime, clients, contracts, tests, fixtures, and product-owned operations
material. It is being prepared from `ghatana/services/media` under the
[expert-reviewed migration plan](docs/migration/expert-reviewed-master-plan.md).

## Migration status

The files here are a migration-preparation copy. The source Media service
remains canonical until a reviewed parity report and cutover manifest satisfy
the migration gates. This checkout is not yet an independently buildable or
qualified runtime: its current Gradle settings and several dependency contracts
still rely on Ghatana workspace projects, and the generated service contract is
intentionally absent pending its source and generator ownership decision
([GAP-02](.product-experience/gaps.yaml), [GAP-06](.product-experience/gaps.yaml)).

The accepted product-definition scope for this session is the migration-specific
P0-001 boundary slice. Other Phase 0–3 product-definition tasks remain pending.
Current source, path, and consumer records are under [`migration/`](migration/)
and [`.product-experience/`](.product-experience/).

## Product boundary

Media owns media-specific artifact and job semantics, streaming, speech, vision,
multimodal processing, consent and lifecycle behavior, and provenance. The
general OCR and Document Intelligence runtime is a Ghatana platform service at
`ghatana/services/document-intelligence`; it is not owned or copied into this
repository. Shared remains the owner of `@ghatana/documents` and
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

- [API documentation](docs/API_DOCUMENTATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Testing](docs/TESTING.md)
- [Privacy and retention policy](docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md)
- [Repository boundary](BOUNDARY.md)

## Repository layout

Runtime modules and providers are at the repository root, with shared runtime
contracts under `runtime-contracts/`. Older desktop applications are preserved
under `archive/media-desktop-apps/` for archival review; they are not represented
as active product capabilities.
