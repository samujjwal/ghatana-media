# Logical surface: `media.surface.cli`

Executable CLI channel. Physical owner: `libs/audio-video-client` (CLI
entry over the typed SDK).

## Supported operations

Structured JSON CLI for artifact/job/capture/recorder operations —
strict schema validation and defined exit codes; no fixture-only
success paths.

## States and invariants

- CLI output is structured JSON on stdout; errors are typed with
  non-zero exit codes.
- All operations flow through the same canonical SDK admission/binding
  rules as programmatic consumers — the CLI is a channel, not a
  privileged path.
- Unknown/reconciling states are reported as such; the CLI never
  upgrades `NOT_ADMITTED`/`OUTCOME_UNKNOWN` to success.

## Dependencies

`@audio-video/client` package; host environment for resolvers and
credentials.

## Errors

Schema violations and admission denials exit non-zero with typed
payloads; transport/provider detail is sanitized.

## Tests

Covered by the client package suite (`pnpm --filter @audio-video/
client test`) including CLI argument/schema and exit-code paths;
package build verifies the executable entry.
