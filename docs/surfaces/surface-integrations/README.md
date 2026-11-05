# Logical surface: `media.surface.integrations`

Owner-interface integration channel. Physical owners: `adapters/*`
(agent-tools-media, data-cloud-media, ledger) and
`providers/aws-postgresql`.

## Supported operations

Installed supported owner interfaces for Shared (identity/observability),
Document Intelligence (OCR delegation), Kernel, Data Cloud (optional
downstream metadata/observation) and Agents (Tools/Action Plane).

## States and invariants

- Optional integrations fail isolated — an unavailable Data Cloud or
  ledger backing degrades that projection only; it never acquires Media
  domain authority or blocks canonical finality.
- Data Cloud adapters remain unavailable compatibility seams pending
  installed public ports; ledger projection now has a single-host durable file backing and a
  pre-dispatch uncertainty fence; real Data Cloud destination CAS is optional,
  never a prerequisite for core Media completion. The new safety tests must
  run before relying on the backing.
- No integration becomes a second writer: canonical job/artifact
  finality stays with Media runtime + `providers/aws-postgresql`.
- OCR is consumed through DI's qualified public client once
  source-authorization, rights, durable operation state and
  host/provider gates are satisfied — never a Media-owned OCR engine.

## Dependencies

Per-adapter owner ports; `runtime-contracts` authority interfaces;
ServiceLoader registration in `providers/aws-postgresql`.

## Errors

Integration unavailability is typed and isolated; permission denial,
lag, retry, duplicate event and outage isolation are required test
axes per plan.

## Tests

Per-adapter Gradle tasks (`:services:media:adapters:*:test`); provider
store tests under `:services:media:providers:aws-postgresql:test`.
