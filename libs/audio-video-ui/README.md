# `@audio-video/ui`

Reusable React controls and screens for Ghatana Media, built on the shared
design system. This is a library for host applications, not a deployed Media
product or an identity, persistence, playback-host, or provider authority.

## Vision and consumers

Give Media hosts accessible, source-truthful controls for canonical Media
contracts without creating a second state or design system. Consumers include
the Media Experience Explorer and sibling UI packages such as
`ai-voice-ui-react`.

## Requirements and current scope

- Render loading, refusal, unknown, pending, and final states truthfully.
- Keep user actions behind typed host ports and the local dispatch guard.
- Keep the interactive demo player deterministic, keyboard-operable, and
  source-bound; it does not execute bundle scripts or dispatch product effects.
- Keep DEV_ONLY project/timeline behavior isolated and visibly local.

Production hosting, identity, durable project state, source rights, provider
effects, and human approval belong to their owning hosts; this package does not
establish them.

## Architecture and design

`src/components/`, `src/screens/`, `src/player/`, and `src/ports/` separate
semantic controls, screen composition, deterministic embedded playback, and
host-owned adapters. Shared design-system controls and tokens remain the visual
authority. Public package entry points are the explicit `exports` in
`package.json`; source files without an export mapping are implementation
details.

The player uses native audio/video elements, exact manifest and host-attestation
binding, explicit origin capabilities, authored caption timing, and reducer-
owned branch state. A local fixture verifier proves only local preview behavior;
the host must verify signed bundles and rights before hosted use.

## Examples

- Package and screen contracts: [surface guide](../../docs/surfaces/libs-audio-video-ui/README.md).
- Interactive player and local fixture: [player guide](../../docs/surfaces/surface-interactive-demo-player/README.md).
- DEV_ONLY project/timeline workspace: see `DevProjectTimelineWorkspaceScreen`
  and its browser selector in the surface guide. Its exact-revision comparison
  reports stored graph changes only; it does not infer rendering or source
  authority.

## Configuration and errors

React is a peer dependency; the package uses workspace client and shared design
system packages. Screens receive host ports as props. No credentials or
provider configuration are read by this package. Missing or mismatched
admission produces typed refusal or unknown states, not simulated success.

## Testing and evidence

Run `pnpm --filter @audio-video/ui typecheck`, `pnpm --filter @audio-video/ui
test`, and `pnpm --filter @audio-video/ui build`. The player has focused state
tests and a loopback-only browser selector documented in its surface guide.
These commands prove local package behavior only, not production hosting,
rights, accessibility certification, release, or journey acceptance.

## Change policy

Keep public exports and contract fields aligned with owning PDP sources and the
package export map. Add behavior tests for refusal, stale identity, boundary,
and recovery paths. Do not add a second design system, runtime owner, or
product route here.
