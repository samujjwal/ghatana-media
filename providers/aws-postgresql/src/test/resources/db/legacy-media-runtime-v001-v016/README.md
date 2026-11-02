# IP-06 historical migration fixture (test only)

These SQL files are copied byte-for-byte from the read-only historical repository at commit `d62557fdaac7a324e036ca25f672d2a62ac532ea`, path `providers/aws-postgresql/src/main/resources/db/media-runtime/V001__media_runtime_state.sql` through `V016__media_lifecycle_outbox_leases.sql`.

This directory is under `src/test/resources` solely to reproduce the source lineage in an isolated Testcontainers PostgreSQL schema. It is not a production migration location and must never be added to production Flyway configuration. `manifest.csv` records source versions/descriptions and Flyway checksums captured by the focused test.

## Reproducible snapshot artifacts

The checked-in snapshot artifacts are in the sibling test-resource directory `db/legacy-media-runtime-v001-v016-snapshot/`, outside this Flyway migration location so migration-name validation continues to see only V001–V016. They are test artifacts for historical source commit `d62557fdaac7a324e036ca25f672d2a62ac532ea`. The applied-history capture was produced on **2026-11-02 UTC** by PostgreSQL **16** in the isolated Testcontainers fixture. Its four IP-06 records are synthetic (`ip06-tenant`, `ip06-artifact`, `ip06-job`, `ip06-transcript`, `ip06-event`); there is no customer or deployed database data.

Reproduce and validate both checked-in artifacts with:

```bash
./gradlew :services:media:providers:aws-postgresql:test \
  --tests com.ghatana.media.provider.aws.MediaLegacyMigrationSnapshotArtifactTest \
  --tests com.ghatana.media.provider.aws.MediaLegacyMigrationHistoryReadbackTest
```

The deterministic SQL reconstruction embeds the exact V001–V016 fixture SQL, per-file SHA-256 values, synthetic rows, and a manifest-backed history projection. The separate PostgreSQL 16 readback validates every applied version, description, checksum, and success value against `manifest.csv`, and emits the captured `installed_rank`, `installed_by`, `installed_on`, and `execution_time` to `build/reports/test-snapshots/ip06-v001-v016-applied-history.csv`. The generator test byte-compares its SQL with the checked-in `test-snapshot.sql` and validates all 16 checked-in applied-history rows while preserving captured installation columns. `installed_on` and `execution_time` are run observations and can differ on a later reproduction. These files are historical/test-only fixtures; they are not a deployed history export, a production database dump, or evidence of data cutover.
