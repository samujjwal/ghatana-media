"""Core-dump policy for document/model-bearing worker processes (OCR-RUN-25)."""

from __future__ import annotations

import ctypes
import faulthandler
import os
from dataclasses import dataclass

try:
    import resource
except ImportError:  # pragma: no cover - Windows workers
    resource = None  # type: ignore[assignment]


CORE_DUMP_POLICY_SCHEMA = "document-intelligence.core-dump-policy.v1"


@dataclass(frozen=True)
class CoreDumpPolicy:
    schema_version: str
    core_limit: tuple[int, int] | None
    dumpable_disabled: bool
    fault_handler_disabled: bool
    errors: tuple[str, ...] = ()

    @property
    def enforced(self) -> bool:
        return self.core_limit == (0, 0) and self.fault_handler_disabled and not self.errors

    def to_record(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "coreLimit": list(self.core_limit) if self.core_limit is not None else None,
            "dumpableDisabled": self.dumpable_disabled,
            "faultHandlerDisabled": self.fault_handler_disabled,
            "enforced": self.enforced,
            "errors": list(self.errors),
        }


def _disable_linux_dumpable() -> bool:
    if not sys_platform_linux():
        return True
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        prctl = libc.prctl
        prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        prctl.restype = ctypes.c_int
        # Linux PR_SET_DUMPABLE = 4.  Children inherit the non-dumpable state.
        return prctl(4, 0, 0, 0, 0) == 0
    except (AttributeError, OSError):
        return False


def sys_platform_linux() -> bool:
    return os.name == "posix" and os.uname().sysname.lower() == "linux"


def apply_core_dump_policy(*, strict: bool = True) -> CoreDumpPolicy:
    """Disable uncontrolled core dumps and Python traceback dump handling.

    The policy is applied in the worker before provider startup and is also
    re-applied by the bounded subprocess runner before spawning a child.  A
    failure is fatal in strict startup mode; non-strict mode lets a provider
    call fail closed without exposing a sensitive diagnostic.
    """

    errors: list[str] = []
    core_limit: tuple[int, int] | None = None
    dumpable_disabled = True
    fault_handler_disabled = False

    try:
        if resource is None:
            raise OSError("resource module unavailable")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        core_limit = (0, 0)
    except (AttributeError, OSError, PermissionError, ValueError) as exc:
        errors.append("CORE_RLIMIT_UNAVAILABLE")

    dumpable_disabled = _disable_linux_dumpable()
    if not dumpable_disabled:
        errors.append("PROCESS_DUMPABLE_UNAVAILABLE")

    try:
        faulthandler.disable()
        fault_handler_disabled = not faulthandler.is_enabled()
    except (AttributeError, RuntimeError):
        errors.append("PYTHON_FAULTHANDLER_UNAVAILABLE")

    policy = CoreDumpPolicy(
        CORE_DUMP_POLICY_SCHEMA,
        core_limit,
        dumpable_disabled,
        fault_handler_disabled,
        tuple(errors),
    )
    if strict and not policy.enforced:
        raise RuntimeError("CORE_DUMP_POLICY_UNAVAILABLE")
    return policy
