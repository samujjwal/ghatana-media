# Canonical interface parity

This directory records source-grounded operation parity against PDP-1. It does
not declare an observed interface equivalent to a domain operation without an
explicit binding. The detailed interface inventories and per-operation
observations remain in
[`operations.yaml`](../pdp-1-domain-data/operations.yaml); this matrix gives
the current denominators and dispositions.

`mapped-proposal` means a proposed family association exists and still needs
semantic owner approval. `transport-only` is reserved for protocol mechanics
with no product operation meaning. `internal-only` is reserved for
implementation-private behavior. `unresolved` means evidence does not support
an equivalence. The current inventory has no accepted canonical mappings.

The matrix also records source-grounded candidate crosswalks for HTTP routes,
fixture CLI commands, SDK methods, Agent Tool names, and lifecycle event names.
These remain `mappedProposal` inputs for domain-owner review; they do not change
the zero accepted count or establish runtime reachability, wire compatibility,
authorization, event delivery, or release support. Entries without direct
source support remain unresolved.

Do not use the status counts as implementation or support claims. Counts are
source inventory denominators from PDP-3 registries and active source files.

## CLI denominator reconciliation

The current CLI fixture registry and `parseMediaCommand` dispatch establish
11 fixture command identities. The separate product command proposal registry
contains 12 records because it adds `media.cli.job.retry`; source marks that
record's request shape as proposed, and the fixture parser has no retry branch.
Classify that extra record as a **product proposal**, not a fixture command.
The parser's `help` result and executable `--help` handling are control paths,
not a twelfth command identity. The earlier “12 observed fixture commands”
count is not supported by these current sources and remains recorded as an
unresolved source discrepancy rather than silently changing the 11-command
denominator.
