# Document Intelligence source -> destination migration crosswalk (MDI-002, PROPOSED)

**Source (read-only):** `samujjwal/ghatana` `origin/main` @ `7d81f267bc7fe1149557d827e029a0dfd09bc6ab`, path `services/document-intelligence/`.  
**Destination:** `samujjwal/ghatana-media` `services/document-intelligence/` (this repository).  
**Machine-readable per-file digests:** `services/document-intelligence/MIGRATION-MANIFEST.json`.  
**Active deployment writer:** Ghatana (unchanged). The Media copy is `INACTIVE_PENDING_CUTOVER`.

| Source (Ghatana) | Destination (Media) | Disposition |
| --- | --- | --- |
| `services/document-intelligence/src/document_intelligence/**` (worker, providers, runtime, rights/learning) | same relative path under `services/document-intelligence/` | copied verbatim |
| `contracts/**` (`document-intelligence.v1` schemas, fixtures, `shared-contract.lock.json`) | same | copied verbatim (frozen protocol, no v2) |
| `capabilities/**`, `profiles/**`, `routing/**`, `config/**`, `models/**` manifests | same | copied verbatim; model weights are referenced, not copied |
| `evaluation/**`, `learning/**`, `release/**`, `verification/**`, `deployment/**`, `docs/**`, `scripts/**`, `tests/**` | same | copied verbatim |
| `clients/java/**` | same | copied; `build.gradle.kts`, `settings.gradle.kts`, `README.md` adapted (Media version catalog, maven-publish, contract manifest); adversarial tests **added** |
| `clients/typescript/**` | same | copied; `package.json`, `src/client.ts`, `README.md` adapted (exports, optional `maxResponseBytes`, additive `cancelWithOutcome`); `tests/hardened-transport.test.ts` **added** |
| `Dockerfile`, `pyproject.toml`, `uv.lock`, `.gitignore`, `.dockerignore` | same | copied verbatim |
| (none) | `services/document-intelligence/MIGRATION-MANIFEST.json` | added |
| (workspace) | `pnpm-workspace.yaml` entry `services/document-intelligence/clients/*` | added (build-path adaptation) |
| `ghatana/services/media/modules/intelligence/document-intelligence-worker` (pre-MDI-001 location, MIG-002) | superseded by the row set above | see `migration/path-map.yaml` (historical) |

## Consumers (bind to the published client/Kernel facade only)

| Consumer | Binding | State |
| --- | --- | --- |
| Kernel DI facet (OCR/parse) | DI Java client `dev.ghatana.documentintelligence:document-intelligence-java-client` / TS `@ghatana/document-intelligence-client` | contract defined; not installed from a published immutable artifact yet |
| Media scene-text (`libs/audio-video-client/src/scene-text-adapter.ts`, Java `DocumentIntelligenceHttpClient`) | structural `DocumentIntelligenceV1Client` (parse/providers only) | existing; single-authority tests guard it |
| Other products (Gharbatai etc.) | published client | per `docs/migration/ocr-consumer-inventory.v1.json`; unchanged |

## Cutover state

| Dimension | State |
| --- | --- |
| Source | copied + digest-manifested; parity verified at manifest time only |
| Data (models/runtime state) | not migrated; Ghatana remains owner |
| Consumers | not rebound |
| Endpoint | not switched; one active writer = Ghatana |
