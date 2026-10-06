# Media vision

Media makes governed audio, video, image, speech, spatial, and time-based
work understandable and reviewable from user intent through an approved
output. A person or integrating product should be able to preserve the exact
source, understand what was observed or changed, recover from uncertain work,
and see the authority, provenance, rights, quality, and finality boundaries of
the result.

## Consumers

- Media product, design, accessibility, quality, privacy, and runtime owners.
- Web, CLI, API, SDK, embedded, and event consumers after their contracts are
  owner-approved and published.
- Ghatana Tools and Shared as upstream contract owners, not as Media semantic
  authorities.
- Reviewers who need to inspect product truth, design language, product
  experience, and Explorer projections without mistaking a proposal for a
  shipped capability.

## Non-goals

Media does not own generic identity, Document Intelligence, Data Cloud read
models, event delivery mechanics, generic model/provider mechanics, or
privileged effects. The Product Experience Explorer is a read-only projection
and is not a fifth product-definition phase, a runtime host, or an acceptance
authority.

This repository does not claim that a capability, provider, model, asset,
package, route, or fixture is licensed, qualified, available, or production
ready merely because it is described or present in the tree.

## Phase progression

The generic master prompt names the four Product Definition phases as PDP-0
Product Truth, PDP-1 Canonical Domain and Data Model, PDP-2 Design Language and
Interface System, and PDP-3 Complete Product Experience. The Media repository
keeps its established local P0/P1/P2/P3 workstream names, so the explicit
crosswalk is: local P0 contains PDP-0 plus the authored domain/state/data
records; local P1 maps to PDP-2; local P2 maps to PDP-3; and local P3 is the
Experience Explorer projection/verification adapter, not a fifth semantic
authority. This prevents the local directory names from silently changing the
master-prompt authority hierarchy.

The complete vision-to-requirement-to-experience crosswalk is maintained in
[PRODUCT-DEFINITION-COVERAGE.md](PRODUCT-DEFINITION-COVERAGE.md) and its
machine-readable ledger
[../.product-experience/vision-requirements-coverage.yaml](../.product-experience/vision-requirements-coverage.yaml).
Each of the ten P0 outcomes is linked to requirement groups and either a
canonical journey or an explicitly classified supporting view. Each later
phase retains those links; implementation, owner acceptance, currentness, and
native evidence remain separate statuses.

Only the P0-001 migration boundary slice is accepted in the current source
tree; the remaining phase material is proposal or local implementation work
until its owner and native evidence gates are satisfied.
