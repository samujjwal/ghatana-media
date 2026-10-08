# Executable UI source inventory

The source-pinned row inventory is [`executable-ui-inventory.json`](./executable-ui-inventory.json). It contains 158 source records from the current workspace observation at Git baseline `cae6fc6bd60e48a3fe945a4a8873bb928a2d67b1`. Every entry carries a SHA-256 of observed bytes and a dirty/untracked marker so the baseline does not hide working-tree edits.

| Source scope | Records | First disposition | Main consumers/runtime |
|---|---:|---|---|
| `libs/audio-video-ui/**` | 23 | FIX | Active Media package; `MediaTaskFlow` and `MediaProgress` are reused by AI Voice |
| `modules/intelligence/ai-voice/libs/ai-voice-ui-react/**` | 16 | REUSE | AI Voice React package; audio playback, waveform, stem and transcript workflows |
| `apps/media-experience-explorer/**` | 8 | UNRESOLVED | Explorer host, simulation adapter, browser DOM and fixture stylesheet |
| `archive/media-desktop-apps/**` | 111 | ARCHIVE_ONLY | Historical desktop sources and tests; no active surface admission |

The inventory records public-export observations, purpose, applicable PDP review obligations, consumer observations, state/variant status, accessibility and responsive review status, runtime coupling, sibling tests, and disposition. Dispositions use `REUSE`, `FIX`, `CONSOLIDATE`, `REPLACE`, `ARCHIVE_ONLY`, or `UNRESOLVED`; each unresolved row carries its reason. A field marked pending means the source has not been accepted as evidence for that claim. See [`gui/reuse-audit.yaml`](./gui/reuse-audit.yaml) for the 28-family, template, layout, and style-authority crosswalk and its exact blockers.

## Decisions recorded

- `libs/audio-video-ui` remains the only Media presentation package. Existing browser hooks and Shared primitive re-exports stay available for compatibility.
- AI Voice implementation is retained as valuable implementation evidence. Its component contracts, consumer graph and visualization semantics need owner review before consolidation or admission.
- Explorer source is host/proposal rendering evidence. Its routes do not admit Product screens. Its eight source rows remain `UNRESOLVED` because this inventory does not establish whether each host path should be fixed, consolidated, or replaced during architecture integration.
- Archived desktop code remains historical evidence only.
- `PhraseTimeline` maps phrase labels to local colors and `StemTrack` uses local custom-property fallbacks. Both are classified `UNRESOLVED` in `gui/semantic-component-bindings.yaml`: the category names may be useful domain distinctions, but the current palettes have no admitted semantic or reviewed categorical-visualization binding.
- No inventory record is an executable-representation admission. The admission registry currently contains zero records.

## Review limitations

Static source inventory does not establish exhaustive state/variant coverage, rendered accessibility, responsive behavior, full consumers, or complete test coverage. Those remain review tasks for each representation slice. Media's frozen pnpm composite install and Explorer dependency-closure build/typecheck pass using local Shared and Tools sources. The Media UI also passed isolated TypeScript and Vite consumer checks against nine locally packed Shared `0.1.0-SNAPSHOT` artifacts. Public registry resolution and immutable release binding remain unverified. The former `0.1.2` mismatch is corrected. The local structural stylesheet is not a qualified Shared theme.
