-- H2 vendor counterpart of V037: no trigger guard here. The append-only guard for the rights and consent ledger
-- (V036) is PostgreSQL plpgsql (db/media-runtime-vendor/postgresql/V037__...); H2 only serves the migration lineage
-- fixture, which must record the same version sequence. The guard itself is proven on PostgreSQL by Testcontainers
-- tests. This file only restates the table's documentation; no application behaviour depends on it.
COMMENT ON TABLE media_rights_attestation_events IS
    'Append-only second-person confirmations and revocations of an attestation (database trigger guard exists on PostgreSQL only).';
