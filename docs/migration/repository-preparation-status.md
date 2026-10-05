# Ghatana Media

Ghatana Media is the standalone product destination for the media runtime,
clients, contracts, tests, fixtures, build metadata, deployment and operations
material. The reusable document-intelligence runtime remains a Ghatana platform
service and is not part of this product repository.

## Migration status

This repository is being prepared as a behavior-preserving extraction from
`ghatana/services/media`. Until a reviewed cutover manifest is executed, that
path remains canonical and this repository remains migration-only. The migration
plan and current path/consumer/contract inventories live in `docs/migration/`
and `migration/`.

The generic Document Intelligence/OCR worker is excluded from the product
transfer and is being rehomed to `ghatana/services/document-intelligence`;
Media may consume its public client for scene-text recognition.

The product definition work for Phase 0–3 is intentionally pending. The accepted
Phase-0 boundary slice exists only to establish ownership and compatibility
conditions for migration preparation; it does not define full product meaning,
design language, complete experiences, or an Experience Explorer.

No source relocation or repository registration implies runtime qualification,
production availability, data transfer, model admission, or activation.
