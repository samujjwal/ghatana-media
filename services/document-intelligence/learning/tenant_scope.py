"""Tenant-scope authority for learning artifacts (I5-34, I5-36, I5-38).

The file authority has no database RLS, so tenant isolation is enforced by
construction: tenant-local roots live inside a tenant partition directory

    learning/feedback/events/<tenantRef>/<rootName>/{events,tombstones}/

and every scope-sensitive producer/consumer asserts the partition it operates
on. A TENANT_LOCAL artifact may never be promoted to a non-tenant-scoped
authority without explicit reclassification to SYNTHETIC_PUBLIC or
MULTI_TENANT_EXPLICITLY_AUTHORIZED plus a scope authorization reference.

Policy: ``learning/policies/tenant-scope.v1.yaml``.
"""
from __future__ import annotations

from pathlib import Path

TENANT_LOCAL = "TENANT_LOCAL"
MULTI_TENANT = "MULTI_TENANT_EXPLICITLY_AUTHORIZED"
SYNTHETIC_PUBLIC = "SYNTHETIC_PUBLIC"
TENANT_SCOPES = (TENANT_LOCAL, MULTI_TENANT, SYNTHETIC_PUBLIC)

TENANT_SCOPED_AUTHORITY = "TENANT_LOCAL"


class TenantScopeError(ValueError):
    """Raised when a scope declaration or partition check fails closed."""


def sanitize_tenant(tenant_ref: str) -> str:
    """Filesystem-safe tenant partition component."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in tenant_ref)


def tenant_partition_dir(base: Path, tenant_ref: str) -> Path:
    """The partition directory for one tenant under an event/artifact base."""
    return Path(base) / sanitize_tenant(tenant_ref)


def assert_partitioned_root(root: Path, tenant_ref: str) -> None:
    """RLS-equivalent: ``root`` must sit directly inside the tenant partition."""
    if Path(root).parent.name != sanitize_tenant(tenant_ref):
        raise TenantScopeError(
            f"root {root} is not inside the tenant partition for {tenant_ref!r}"
        )


def event_tenant_ref(event: dict) -> str | None:
    """Tenant identity declared on a feedback event, when the event carries one.

    feedback-event.v1 does not require tenant metadata; projectors that add it
    use ``tenantRef``/``organizationId`` at the top level or under
    ``ownership``. Absence means the tenant is inherited from the partition.
    """
    for key in ("tenantRef", "organizationId"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    ownership = event.get("ownership")
    if isinstance(ownership, dict):
        for key in ("tenantRef", "organizationId", "ownerRef"):
            value = ownership.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def resolve_dataset_tenant(
    events_root: Path,
    tenant_scope: str,
    tenant_ref: str | None,
    scope_authorization_ref: str | None,
) -> str | None:
    """Validate a dataset scope declaration and resolve its tenant identity.

    - TENANT_LOCAL requires an identified tenant: an explicit ``tenant_ref``
      whose partition contains ``events_root``, or a root already partitioned
      under ``<tenantRef>/<root>`` (the partition name is the tenant).
    - MULTI_TENANT_EXPLICITLY_AUTHORIZED requires ``scope_authorization_ref``.
    - SYNTHETIC_PUBLIC carries no tenant identity requirement.
    """
    if tenant_scope not in TENANT_SCOPES:
        raise TenantScopeError(f"unknown tenantScope {tenant_scope!r}")
    if tenant_scope == MULTI_TENANT:
        if not scope_authorization_ref:
            raise TenantScopeError(
                "MULTI_TENANT_EXPLICITLY_AUTHORIZED requires scopeAuthorizationRef"
            )
        return tenant_ref
    if tenant_scope == SYNTHETIC_PUBLIC:
        return tenant_ref
    # TENANT_LOCAL
    if tenant_ref:
        assert_partitioned_root(events_root, tenant_ref)
        return tenant_ref
    partition = Path(events_root).parent.name
    # ``events`` is the unpartitioned collection directory itself, not a
    # tenant partition — a legacy root under it carries no tenant identity.
    if partition and partition != "events" and sanitize_tenant(partition) == partition:
        return partition
    raise TenantScopeError(
        "TENANT_LOCAL dataset requires --tenant-ref or a tenant-partitioned events root"
    )


def assert_event_scope(event: dict, tenant_scope: str, tenant_ref: str | None) -> None:
    """Assert one contributing event is consistent with the declared scope."""
    declared = event_tenant_ref(event)
    if tenant_scope == TENANT_LOCAL and declared is not None and declared != tenant_ref:
        raise TenantScopeError(
            f"event {event.get('eventId')} declares tenant {declared!r}, "
            f"outside the TENANT_LOCAL partition {tenant_ref!r}"
        )


def assert_promotable_scope(manifest: dict, authority_scope: str) -> None:
    """I5-38: a TENANT_LOCAL candidate cannot promote to a non-tenant-scoped
    authority. Promotion to a shared/global authority requires the candidate to
    be reclassified SYNTHETIC_PUBLIC or MULTI_TENANT_EXPLICITLY_AUTHORIZED and
    to carry a scope authorization reference.
    """
    scope = manifest.get("tenantScope", TENANT_LOCAL)
    if authority_scope == TENANT_SCOPED_AUTHORITY:
        return
    if scope == SYNTHETIC_PUBLIC:
        return
    if scope == MULTI_TENANT and manifest.get("scopeAuthorizationRef"):
        return
    raise TenantScopeError(
        f"candidate {manifest.get('candidateId')} with tenantScope {scope} "
        f"cannot promote to non-tenant-scoped authority {authority_scope!r} "
        "without explicit reclassification and authorization"
    )
