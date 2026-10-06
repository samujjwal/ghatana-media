# gRPC operation contract records

This directory contains one source-linked contract record for each active RPC
in [`../service-registry.yaml`](../service-registry.yaml). Records preserve the
fully qualified service/method identity, source proto path, streaming shape,
and request/response message references.

The protobuf declarations are implementation/projection observations here; no
canonical wire authority has been selected. Records do not define product
semantics. The PDP-1 operation proposal is the intended semantic authority only
after phase acceptance. A logical-operation link is present only where the PDP-1
proposal contains an exact source-member mapping. All records remain
proposal-only and pending owner review.
