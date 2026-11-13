# Worker profiles

Two kinds of files live here. Only one kind is ever loaded by the runtime.

## Runtime-loadable profiles

`schemaVersion: document-intelligence.profile.v1` files whose keys are exactly
the loadable set — `profileId`, `enabledProviders`, `mediaTypes`,
`candidateLanguages`, `modelManifest`, `routingPolicy`, and the optional
`providerAuthority`/`providerAuthoritySha256`/`modelManifestSha256` pins — are
parsed by `src/document_intelligence/profile.py` when
`DOCUMENT_INTELLIGENCE_PROFILE_PATH` points at them.

- `increment4a.yaml` — the frozen Increment-4A extended profile.
- `increment4a-candidate.yaml` — the I4A candidate variant.

The loader is strict-subset: any undeclared key fails closed, so a file that
carries documentary-only keys can never be loaded by accident.

## Documentary manifests

- `default.yaml` — enumerates the *implicit* default runtime. The default has
  no file profile by design: `profileId: default` is rejected by
  `WorkerSettings.from_env` when loaded, and this file's extra keys
  (`runtimeLoadable`, `limits`, `admission`, `fallbacks`) make it fail closed
  in the loader regardless. It exists so
  `scripts/check_default_catalog_stability.py` can detect drift between the
  documented catalog and `src/document_intelligence/config.py`.
- `increment5-candidate.yaml` — documentary manifest for the governed-learning
  surfaces (`learning/`). `consumerAdmission: DENIED`; I5 produces candidates
  only, never active authority.
- `increment6-candidate.yaml` — documentary manifest mirroring
  `increment6.yaml` under the candidate naming (`aliasOf: increment6`).

## Profile boundary invariant

The default catalog is frozen at the Increment-3 provider/language/media set.
Candidate code — anything gated behind a file profile or an experimental
manifest — must not change what the no-profile runtime admits. The stability
check script enforces the provider/media/language half of that invariant;
`capabilities/document-intelligence-capabilities.yaml` remains the semantic
authority for per-capability admission.
