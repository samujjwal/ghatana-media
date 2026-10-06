# Media API authority pointer

This file is retained as a compatibility pointer and is not an API authority.
The active contract sources are:

- [OpenAPI](../contracts/openapi/media.yaml), reconciled with the [route manifest](../config/route-manifest.json)
- module protobuf declarations under `modules/*/src/main/proto/`
- [PDP-3 HTTP operation registry](../.product-experience/pdp-3-product-experience/api/api-registry.yaml)
- [PDP-3 gRPC service registry](../.product-experience/pdp-3-product-experience/grpc/service-registry.yaml)
- [PDP-2 interface language](../.product-experience/pdp-2-design-interface-system/api/conventions.yaml)

Generated aggregate `service-contract.yaml` material is not active. See
[ARCHITECTURE](ARCHITECTURE.md), [REQUIREMENTS](REQUIREMENTS.md), and the
[surface registry](../.product-experience/surface-registry.yaml) for ownership,
compatibility, and acceptance status.
