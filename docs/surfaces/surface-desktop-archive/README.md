# Logical surface: `media.surface.desktop-archive`

**ARCHIVED** — not a product runtime. Physical location:
`archive/media-desktop-apps` (historical desktop experiments, e.g.
`ai-voice-desktop`).

## Supported operations

None at runtime. The archive preserves historical source for
inspection; it is not installed or production software.

## States and invariants

- Live imports must be resolved to active components — nothing in the
  product may depend on archive paths.
- The archive may be removed from the tree once independently
  recoverable (Git history) and no consumer depends on it — a
  consolidation decision, not yet executed.
- The withdrawn `apps/desktop` AI Voice application (including its
  nonfunctional `grpc_server.py` success-mock and deployment wrappers)
  must not be resurrected; any future backend is a separately qualified
  rights-aware provider of existing Media contracts.

## Dependencies

None — read-only historical reference.

## Errors

N/A — no runtime surface.

## Tests

No runtime tests; dependency analysis precedes any removal per the
repository-cleanup workstream.
