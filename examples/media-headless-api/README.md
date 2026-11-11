# Headless artifact and job API consumer

Runnable Node.js example of the public `@audio-video/client` package. It reads
one local input file, uploads bounded chunks, completes the upload, reads the
artifact back, submits one `TRANSCODE` job explicitly hinted to the local
diagnostic provider, and polls that job by its exact request ID for a bounded
period.

## Run against a local Media development host

Build the package and run the example from the repository root:

```sh
pnpm --filter @audio-video/client build
GHATANA_MEDIA_BASE_URL=http://127.0.0.1:8080 \
GHATANA_MEDIA_TENANT_ID=tenant-1 \
GHATANA_MEDIA_PRINCIPAL_ID=principal-1 \
GHATANA_MEDIA_BEARER_TOKEN="$MEDIA_BEARER_TOKEN" \
GHATANA_MEDIA_INPUT_FILE=./sample.wav \
GHATANA_MEDIA_CONTENT_TYPE=audio/wav \
pnpm --filter @ghatana/media-headless-api-example start
```

The host must already be running with an authenticated development identity and
the `local-diagnostic` provider available. Supply a bearer token issued by the
host's configured development identity flow; this example does not mint or
install credentials. Remote endpoints must use HTTPS. Optional settings are
`GHATANA_MEDIA_CONTENT_TYPE` (defaults to `application/octet-stream`) and
`GHATANA_MEDIA_CHUNK_BYTES` (defaults to 1 MiB; the host may impose a lower
maximum and the Media launcher caps chunks at 32 MiB). Input must be non-empty
and no larger than 2 GiB. The example
hashes and uploads through one open file handle in bounded blocks. The file
extension or declared content type must make a supported Media format claim
before a session is created; when both are recognized they must agree. The
server still verifies the actual bytes at completion. With the default
`application/octet-stream`, use a supported extension such as `.wav`; an
unknown `.bin` claim or unsupported content type fails before an upload session
is created with a stable input-format error.

To resume an interrupted upload, set `GHATANA_MEDIA_UPLOAD_ID` to the ID
returned by the same tenant/principal session. The example reads that session
from Media and verifies its file name, content type, size, digest,
classification, 24-hour retention policy, metadata and OPEN state against the
local source before appending. `GHATANA_MEDIA_MAX_CHUNKS_THIS_RUN`
can bound a run to a positive number of confirmed chunks; when more bytes remain,
the example prints the upload ID and acknowledged progress and exits without
finalizing. Restart the host if needed, then rerun with that upload ID. A lost
chunk acknowledgment is reconciled by reading the exact session; the SDK never
blindly replays the chunk.

Job polling defaults to 30 seconds at one-second intervals. Set
`GHATANA_MEDIA_JOB_WAIT_MS` to a value from 0 through 300000 and optionally set
`GHATANA_MEDIA_JOB_POLL_INTERVAL_MS` to a positive number of milliseconds.
Each status read has a 30-second timeout by default; set
`GHATANA_MEDIA_JOB_READ_TIMEOUT_MS` from 1 through 300000 to change it. Each
read is aborted at that timeout or the remaining poll budget, whichever comes
first. The first read is capped by the poll budget when it is positive; with a
zero wait it still performs one read, bounded by the read timeout. On timeout,
the final JSON contains the last confirmed point-in-time observation (the
accepted submit response if the first read times out). Thus the total status
journey is bounded by the wait setting, or by the read timeout when wait is
zero. `OUTCOME_UNKNOWN` stops polling immediately and is never converted to
success or terminality.

The example uses only the package's public `operations` and
`canonical-operations` subpaths. It prints artifact metadata and the job's
point-in-time status; it does not print input bytes or the bearer token.

## Limits

- The job is a local diagnostic metadata operation. The local diagnostic
  provider reports `rawMediaRead=false`; no media transformation, transcript,
  playable output, or external provider effect is performed or claimed.
- Job reads are request-bound and scope-verified. A bounded poll may return
  `ACCEPTED` or `RUNNING` at its wait limit; an observed `COMPLETED` status is
  still only the host's canonical status observation, not proof of an external
  provider effect or separately qualified durable finality.
- If a chunk write has an ambiguous acknowledgment, the example reads that
  exact upload session and continues only when the response confirms the chunk
  was appended. It never blindly replays an ambiguous chunk. If the read does
  not confirm the append, the example stops for operator reconciliation.
- A lost acknowledgment before the upload session ID or job ID is received
  cannot be recovered through the routes used here. The current HTTP contract
  has no admitted lookup by upload idempotency key or job request ID alone; the
  example does not invent one or blindly resubmit.
- This consumer example and its mock contract test do not qualify host
  authentication, persistence, provider admission, production behavior, or
  release readiness.

## Focused contract check

```sh
pnpm --filter @audio-video/client build
pnpm --filter @ghatana/media-headless-api-example test
```

The test injects fetch responses and exercises the public package import; it
does not contact a Media host. Its temporary WAV fixture is uploaded as
multiple five-byte chunks, simulates a lost acknowledgment after the first
chunk was accepted, checks session readback recovery and verifies polling from
`ACCEPTED` to `COMPLETED`.

## DEV_ONLY process-restart integration

The authenticated integration test also launches this exact Node example as a
child process against the running launcher backed by Testcontainers PostgreSQL
and S3. It supplies the same owner-issued, signed `DEV_ONLY` identity used by
the raw HTTP upload/restart case, writes a synthetic WAV input, verifies the
uploaded object bytes and digest, restarts the launcher, then reads back the
same SDK-created artifact and diagnostic job:

```sh
pnpm --filter @audio-video/client build \
  && ./gradlew :services:media:integration-tests:test \
       --tests com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT
```

This is local development identity and Testcontainers evidence only. The
diagnostic job reads metadata and reports `rawMediaRead=false`; it proves no
media transformation, external provider finality, production identity, or
release qualification. The integration test is skipped when Docker is
unavailable.
