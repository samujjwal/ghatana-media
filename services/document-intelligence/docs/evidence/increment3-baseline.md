# Increment 3 Shared baseline evidence

Captured before worker/provider implementation on 2026-09-17.

| Command | Result |
| --- | --- |
| `pnpm --filter @ghatana/document-extraction typecheck` | PASS, exit 0 |
| `pnpm --filter @ghatana/document-extraction test` | PASS, 72 files / 1,061 tests |
| `pnpm --filter @ghatana/document-extraction test:coverage` | PASS, 72 files / 1,061 tests; statements 91.79%, branches 90.14%, functions 95.47%, lines 93.82% |
| `pnpm --filter @ghatana/document-extraction build` | PASS, exit 0 |
| `pnpm --filter @ghatana/document-extraction test:consumer` | PASS, boundary/consumer/packed-consumer checks passed |

The Shared repository was not changed for this increment. `CONSUMERS.md` and `config/consumers.json` remain frozen.
