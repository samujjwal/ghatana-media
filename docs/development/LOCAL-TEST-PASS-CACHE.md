# Local test-pass cache

Run the CLI with a JSON config: `node scripts/local-test-pass-cache.mjs --config <config.json>`. The config must name the check, repository-relative source/transitive inputs, provider profile and source revision, exact test argv, toolchain version commands, and fixture SHA-256.

Use `deterministic-local` only for repeatable local checks whose result does not depend on a live host, provider, or measurement. Use `current-host-only` for host/provider/measurement checks: it always invokes the command and never reads or writes reusable entries. A command must return exit code 0 and one complete Node TAP summary with at least one passing test and no failures, cancellations, skips, or todo cases. Output from this cache is a developer convenience, not lifecycle evidence or closure.

Example config for a deterministic local Node test:

```json
{
  "checkId": "sample-contract-test",
  "reusePolicy": "deterministic-local",
  "inputs": ["src/contract.ts", "tests/contract.test.mjs", "tests/fixtures/contract.json"],
  "providerProfile": "none",
  "providerSourceRevision": "none",
  "toolchainVersionCommands": [["node", "--version"], ["pnpm", "--version"]],
  "command": ["node", "--test", "--test-reporter=tap", "tests/contract.test.mjs"],
  "fixtureDigest": "<64-character SHA-256 digest of the test fixture set>"
}
```
