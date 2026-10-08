# Media Experience Explorer browser audit

The Explorer production preview completed the browser audit with exit status 0 on 2026-10-08. The full machine report is in [`report.json`](report.json), with the eight retained screenshots in [`screenshots/`](screenshots/).

The run used Chromium via Playwright against `http://127.0.0.1:4179/`. It exercised 30 Explorer scenarios, six viewports, 315 specification artifacts, and 282 legacy proposal URLs in read-only Specification mode. The report records zero console errors, page errors, policy violations, or audit failures. The audit also exercised text scaling, page zoom, keyboard navigation, forced colors, reduced motion, long-label stress, touch targets, and initial-focus visibility.

This evidence covers the built local Explorer preview and source-available fixtures. It does not establish production-host parity, screen-reader behavior, independent visual review, canonical-reference conformance, translation quality, RTL readiness, provider/runtime qualification, or phase acceptance. The report explicitly retains the unverified manual gates.

Build and source scope fingerprints:

- Repository HEAD at run: `355d50ec68faac13c692cbd29df75f147e3c04fa` (the worktree also contained uncommitted owner-plan changes).
- Explorer source tree (`apps/media-experience-explorer/src`, sorted path and per-file SHA-256 stream): `98c8ddaaa4db64ab7a44f7d3defa6166f4886aeb1762fbe01c77a0a223ffaa0b`.
- Built `dist/index.html`: `997cf2a559620c734ef0adc8b923838fc5ee8b8e7f7bcd7e2d9ba3f83f0cc48d`.
- Built CSS asset: `723cdbb18398ae7e22d0a8b886dcea957c59de78791e4fce22e83c4998a979df`.
- Built JavaScript asset: `95df808694e96b54ce8b16edfb6eeef160e0f49067b2a5b8087eb8c602a34a66`.
- PDP-3 candidate input: `b28af7aa901709300af1e99f8c611994b7ca90486c320d66df196f87f2bda769`.
- PDP-2 candidate input: `8d7b239180d38050adf37365ade2d3b4a7e8728085454a2f1652db9d25cad1bb`.
- Explorer specification artifact index: `63ad69a347c56da7398882d95797dec81251a326e4bd7304066064ae877b6c20`.

The repository build output under `apps/media-experience-explorer/dist` is not part of this evidence snapshot; the hashes identify the exact local build that was served. The structured browser report and screenshots are the retained artifacts.
