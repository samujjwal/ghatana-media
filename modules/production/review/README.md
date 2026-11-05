# Versioned review records

This module is a source-compatible development slice for `media.dev.versioned-review-and-approval`.
It appends comments and reviewer decision statements to an externally issued review case for one exact
immutable version. Comments may carry a rational source/story time range and a normalized ROI. Every
append uses a caller-supplied case revision for compare-and-set, a tenant/principal-scoped request ID,
explicit target/effect confirmation, fresh injected authorization/currentness/retention evaluation,
and a text sanitizer before storage and disclosure.

An `ACCEPT` decision is only an append-only reviewer statement. The J-21 source contract explicitly
separates this record from `HUMAN_REVIEW_APPROVAL`; approval remains a read-only current authority
observation, and neither this record nor its receipt authorizes delivery or publication. A change to
the current material version makes prior records stale in subsequent observations. Missing or unknown
retention/currentness fails closed.

`InMemoryReviewStore` is process-local and accepts only externally supplied case references. It does
not mint owner review cases and is not a canonical, durable, or multi-host writer. The module is not
wired into Media runtime, UI, a rights authority, an owner receipt service, or a production review
workflow. The task remains in progress until those integrations and the authentic owner boundary are
available.

Source references: `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml`;
`.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.record-version-review-decision`;
`.product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml`.
