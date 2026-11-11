# Logical surface: `media.surface.cli`

Executable CLI channel. Physical owner: `libs/audio-video-client` (CLI
entry over the typed SDK).

## Admitted production operation

The installed `ghatanamedia-api` command registry currently admits only
`artifact inspect`, a scoped read through `MediaOperationClient.getArtifact()`.
It requires an explicit endpoint and tenant/principal/artifact IDs, with the
bearer token read from `GHATANA_MEDIA_BEARER_TOKEN`. The registry and source
crosswalk are authoritative for CLI admission; broader SDK methods and
Explorer fixture commands do not add installed CLI commands.

The production executable rejects artifact upload, upload-session inspection,
job, batch, capture, recorder, and stream command identities as
`INVALID_INVOCATION` before credential or network dispatch. Production
admission remains open.

The separate `ghatanamedia-api-dev` executable has a local-development source
registry for `artifact upload`, `artifact inspect`, `job get`, and `job cancel`.
This records the selected local-development-only extension against the earlier
PXD-051 exclusion; it does not amend the production registry or admit any
production command.
It requires a loopback endpoint and a short-lived DEV_ONLY identity whose
signature and current authority are verified by the Media host. Upload, artifact
inspection, and job read bind to existing scoped HTTP operations. Cancellation
uses a separate signed DEV_ONLY `POST /dev/v1/jobs/{jobId}/cancel` route with a
durable request ID, optional expected job version, and same-key replay. An
active LOCAL job whose provider has no cancellation callback receives a
cooperative runtime cancellation signal only after its request receipt is
stored; the result remains `REQUESTED_UNCONFIRMED` until job/provider evidence
establishes finality. A job already terminal before reservation returns
`ALREADY_TERMINAL`; different request IDs or payloads conflict only after
reservation. Production admission remains `OPEN`, and the production
registry still contains only `artifact inspect`. This local-development
binding does not qualify a production host or close the broader CLI task.

## States and invariants

- CLI output is structured JSON on stdout; errors are typed with
  non-zero exit codes.
- The admitted operation flows through the same canonical SDK admission/binding
  rules as programmatic consumers — the CLI is a channel, not a
  privileged path.
- The development executable checks the DEV_ONLY claim profile and loopback
  endpoint before dispatch; host signature verification remains authoritative.
- The artifact query returns a point-in-time observation; unavailable reads do
  not establish global absence or failure.
- Unadmitted commands fail closed before authentication or dispatch.

## Dependencies

`@audio-video/client` package; host environment for resolvers and
credentials.

## Errors

Schema violations and admission denials exit non-zero with typed
payloads; transport/provider detail is sanitized.

## Tests

Covered by the client package CLI tests, source registry/crosswalk regression,
and packed consumer checks for the executable entry, DEV_ONLY cancellation
request/replay envelope, and fail-closed production command boundary. Local
fixtures do not qualify a production host.
