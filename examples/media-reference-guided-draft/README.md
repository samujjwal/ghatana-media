# Local reference-guided draft example

This runnable Java example consumes `example-request.json` through the existing
`ReferenceGuidedScenePlanner` and prints a deterministic JSON candidate. The
request contains authored prompt/template/continuity text and exact synthetic
sample reference identifiers, versions, and digests. It does not ingest media.

From the Media repository root, run:

```sh
./gradlew :services:media:examples:media-reference-guided-draft:run \
  --args='example-request.json'
```

The public command uses an in-memory authority fixture that allowlists only the
four exact source tuples in the bundled request for `tenant-local`,
`creator-local`, and `source-conditioned-scene`. Other source tuples fail
closed. The fixture is local example code, not a rights or production authority.

The output is an authored-template candidate. Its provenance is sorted by the
planner and includes each bound source role, immutable artifact version, and
SHA-256 digest. The seed is stable for unchanged request inputs. The result
always reports `renderable: false`, `persistence: NOT_PERFORMED`, and
`modelDispatch: NOT_PERFORMED`; `modelAvailability` is
`NO_ADMITTED_PROVIDER`. No media is generated, model is called, or project
revision is written.

`example-result.json` shows the expected output for the bundled request. The
tests also exercise prompt/template/continuity/reference changes and authority
denials before any model call.
