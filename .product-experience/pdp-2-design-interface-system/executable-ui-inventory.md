# Executable UI source inventory

The source-pinned row inventory is [`executable-ui-inventory.json`](./executable-ui-inventory.json). It contains 157 source records from the current workspace observation at Git baseline `891ca118872de5888f0dd09c61c2a9f0c6420a12`. Every entry carries a SHA-256 of observed bytes and a dirty/untracked marker so the baseline does not hide working-tree edits.

| Source scope | Records | First disposition | Main consumers/runtime |
|---|---:|---|---|
| `libs/audio-video-ui/**` | 22 | FIX | Active Media package; `MediaTaskFlow` is used by AI Voice |
| `modules/intelligence/ai-voice/libs/ai-voice-ui-react/**` | 16 | REUSE | AI Voice React package; audio playback, waveform, stem and transcript workflows |
| `apps/media-experience-explorer/**` | 8 | REFACTOR | Explorer host, simulation adapter, browser DOM and fixture stylesheet |
| `archive/media-desktop-apps/**` | 111 | ARCHIVE_ONLY | Historical desktop sources and tests; no active surface admission |

The inventory records public-export observations, purpose, applicable PDP review obligations, consumer observations, state/variant status, accessibility and responsive review status, runtime coupling, sibling tests, and disposition. A field marked pending means the source has not been accepted as evidence for that claim.

## Decisions recorded

- `libs/audio-video-ui` remains the only Media presentation package. Existing browser hooks and Shared primitive re-exports stay available for compatibility.
- AI Voice implementation is retained as valuable implementation evidence. Its component contracts, consumer graph and visualization semantics need owner review before consolidation or admission.
- Explorer source is host/proposal rendering evidence. Its routes do not admit Product screens.
- Archived desktop code remains historical evidence only.
- `PhraseTimeline` maps phrase labels to local colors and `StemTrack` uses local custom-property fallbacks. Both are classified `UNRESOLVED` in `gui/semantic-component-bindings.yaml`: the category names may be useful domain distinctions, but the current palettes have no admitted semantic or reviewed categorical-visualization binding.
- No inventory record is an executable-representation admission. The admission registry currently contains zero records.

## Review limitations

Static source inventory does not establish exhaustive state/variant coverage, rendered accessibility, responsive behavior, full consumers, or complete test coverage. Those remain review tasks for each representation slice. Shared dependency publication and consumer binding also remain unresolved: the Media package declares `0.1.2`, while the inspected Shared source packages are `0.1.0-SNAPSHOT`. The local structural stylesheet is not a qualified Shared theme.
