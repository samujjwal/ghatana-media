# AI Voice — Media UI and capability boundary

**Current scope:** Media-owned, **host-dependent React UI library**, not an independent deployed AI Voice service or runnable Tauri desktop. The archived desktop experiments remain under [archive/media-desktop-apps/ai-voice-desktop](../../../archive/media-desktop-apps/ai-voice-desktop/) for historical source inspection, not as installed or production software.

## Active code

- [`@ghatana/ai-voice-ui-react`](libs/ai-voice-ui-react/package.json) exports `PhraseTimeline`, `StemTrack`, `TrainingProgress`, `VoiceProductionWorkflow`, `Waveform` and their typed hooks/interfaces.
- The package consumes `@audio-video/ui` and Shared token/theme/design components. It does **not** grant a product host, model weights, authorization to clone voices, processing rights or a licensed audio provider.
- Canonical Media product meaning is under [PDP-0](../../../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md), [PDP-1](../../../.product-experience/pdp-1-domain-data/DOMAIN-MODEL.md) and [PDP-3](../../../.product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md); implementation status is separate.

## Supported development workflow

From the repository root with a valid development workspace:

```sh
pnpm --filter @ghatana/ai-voice-ui-react typecheck
pnpm --filter @ghatana/ai-voice-ui-react test
pnpm --filter @ghatana/ai-voice-ui-react build
```

These verify a **UI package**. They do not run a voice synthesizer, validate generated audio, or demonstrate a production host. Build and usage may still depend on accepted Shared development artifacts.

## Deliberately retired source

The prior `apps/desktop` application is not present at this active module path. Its `run-dev` scripts, Python setup helper and PyO3/Tauri build, deployment and “implementation complete” guides were obsolete. The Python `grpc_server.py` was a **nonfunctional placeholder** that returned fabricated success text and an unconditionally healthy status; it was not a valid gRPC service with registered generated bindings. Its Dockerfile, Kubernetes deployment and root `start-services`/`stop-services` wrappers were withdrawn, not admitted as live AI Voice infrastructure.

The historical sources and former filenames remain recoverable in Git history and the archival desktop tree. Any future AI Voice backend must be implemented as a separately qualified, rights-aware provider of the existing Media operation contracts. It must not resurrect the success-mock server or silently enable voice cloning.
