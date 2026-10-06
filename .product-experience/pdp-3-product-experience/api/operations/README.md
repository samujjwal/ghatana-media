# HTTP operation contract records

This directory contains one source-linked contract record for each operation
in [`../api-registry.yaml`](../api-registry.yaml). Records preserve the stable
HTTP identity, exact OpenAPI and runtime-route-manifest observations, and schema
references that are directly available from those sources.

OpenAPI and the runtime route manifest are implementation/projection
observations here; no canonical wire authority has been selected. Records do
not define product semantics. The PDP-1 operation proposal is the intended
semantic authority only after phase acceptance. Logical-operation links remain
null unless an exact source-explicit mapping exists; every record is
proposal-only and pending owner review.
