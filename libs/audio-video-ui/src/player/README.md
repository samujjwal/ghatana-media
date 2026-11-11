# Interactive demo player module

**Purpose:** render a host-attested authored demonstration with deterministic
branch, seek, caption, replay, and source-truth controls.

**Consumers:** Media hosts that provide trusted bundle verification and own
origin, identity, rights, and lifecycle controls.

**Non-goals:** signature verification, arbitrary script execution, network
authorization, media generation, project mutation, provider calls, or claims
that local preview is hosted or live product output.

**Change policy:** preserve exact manifest/version binding, explicit origin
capabilities, half-open caption cue timing, keyboard operation, and fail-closed
behavior. Add public manifest fields only when an owning PDP contract defines
them. Keep transcripts and text alternatives faithful to authored content;
never infer descriptions from pixels or invent captions.

See the [package guide](../../README.md) and [logical player surface guide](../../../../docs/surfaces/surface-interactive-demo-player/README.md)
for contract, local use, verification, and remaining host requirements.
