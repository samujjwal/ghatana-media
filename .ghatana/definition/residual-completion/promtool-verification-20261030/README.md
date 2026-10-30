# Native Promtool verification — 2026-10-30

Promtool 3.15.1 is available through a user-scoped Docker-backed command. Run `pnpm check:monitoring-rules` from the Media repository. Both rule files (52 rules) and all 38 fixture scenarios / 102 alert assertions pass. No rule-expression failures were found or suppressed. A stale comment was corrected; parsed rule definitions are unchanged.

The pinned image, read-only/no-network container settings, source hashes, original command observations and user-installation receipt are in verification.json and installation.json. These are offline rule checks, not live alert-delivery or production qualification. The earlier merge report remains unchanged as historical evidence.
