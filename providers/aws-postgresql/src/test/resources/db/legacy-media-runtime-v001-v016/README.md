# IP-06 historical migration fixture (test only)

These SQL files are copied byte-for-byte from the read-only historical repository at commit `d62557fdaac7a324e036ca25f672d2a62ac532ea`, path `providers/aws-postgresql/src/main/resources/db/media-runtime/V001__media_runtime_state.sql` through `V016__media_lifecycle_outbox_leases.sql`.

This directory is under `src/test/resources` solely to reproduce the source lineage in an isolated Testcontainers PostgreSQL schema. It is not a production migration location and must never be added to production Flyway configuration. `manifest.csv` records source versions/descriptions and Flyway checksums captured by the focused test.
