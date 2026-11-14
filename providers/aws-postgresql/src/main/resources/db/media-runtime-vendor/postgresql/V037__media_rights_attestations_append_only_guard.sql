-- Append-only hardening of the rights and consent ledger (V036), enforced by the database itself.
--
-- V036 states that the store has no UPDATE or DELETE path; this makes that a database guarantee so a direct SQL
-- session, a maintenance script or a future code path cannot rewrite who said what about which file. Statements
-- are only ever added; ending one is a separate REVOKED event row. PostgreSQL only: this file lives in the
-- vendor location (db/media-runtime-vendor/postgresql) because the H2 lineage fixture cannot run plpgsql; the
-- h2 vendor directory carries a no-op at the same version.

CREATE FUNCTION media_rights_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'media rights/consent records are append-only: % on % is refused', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER media_rights_attestations_append_only
    BEFORE UPDATE OR DELETE ON media_rights_attestations
    FOR EACH ROW EXECUTE FUNCTION media_rights_reject_mutation();

CREATE TRIGGER media_rights_attestation_events_append_only
    BEFORE UPDATE OR DELETE ON media_rights_attestation_events
    FOR EACH ROW EXECUTE FUNCTION media_rights_reject_mutation();

CREATE TRIGGER media_rights_attestations_no_truncate
    BEFORE TRUNCATE ON media_rights_attestations
    FOR EACH STATEMENT EXECUTE FUNCTION media_rights_reject_mutation();

CREATE TRIGGER media_rights_attestation_events_no_truncate
    BEFORE TRUNCATE ON media_rights_attestation_events
    FOR EACH STATEMENT EXECUTE FUNCTION media_rights_reject_mutation();

-- A revoked statement can never later be confirmed (revocation is final; a new statement must be appended).
CREATE FUNCTION media_rights_reject_confirm_after_revoke() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.event_kind = 'CONFIRMED' AND EXISTS (
            SELECT 1 FROM media_rights_attestation_events e
             WHERE e.tenant_id = NEW.tenant_id
               AND e.attestation_id = NEW.attestation_id
               AND e.event_kind = 'REVOKED') THEN
        RAISE EXCEPTION 'media rights attestation is revoked and cannot be confirmed'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER media_rights_attestation_events_no_confirm_after_revoke
    BEFORE INSERT ON media_rights_attestation_events
    FOR EACH ROW EXECUTE FUNCTION media_rights_reject_confirm_after_revoke();
