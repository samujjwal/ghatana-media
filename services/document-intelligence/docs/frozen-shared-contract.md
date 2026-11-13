# Frozen Shared contract

The worker consumes the exact public package `@ghatana/document-extraction` at version `0.1.0-SNAPSHOT`. The semantic authority is captured in `contracts/shared-contract.lock.json`; it includes the public type snapshot digest, runtime exports, provider-port signatures, error code set and extraction limits.

If verification differs, the required action is `SHARED_CONTRACT_REOPEN_REQUIRED`. The lock must not be refreshed automatically.
