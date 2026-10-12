# Media dependency profiles

Media has two build-resolution profiles, as required by DEP-01:

- `DEV_SOURCE_COMPOSITE` is the default. It may use the checked-out Shared, Tools, Kernel, Lifecycle, and Ghatana source boundaries for development. It does not qualify installed artifacts or release readiness.
- `RELEASE_ARTIFACT_ONLY` disables sibling composite substitutions, sibling project inclusion, and Shared build-logic source inclusion. It requires a complete admitted artifact lock with immutable coordinates, SHA-256 digests, license/SBOM evidence, and source-free installed-consumer evidence.

The current lock is [NOT_ADMITTED](../../config/dependency-admission/release-artifact-lock.json). Selecting the release profile therefore fails during settings evaluation. This is the intended result until the six required artifact families have real owner-issued records and consumer evidence. The checked-in candidate does not authorize publication, license use, consumer cutover, production deployment, or release.

Dependency versions remain selected by Toolchain policy. Media declares the surface-specific dependency needs in [dependency-profile-policy.json](../../config/dependency-profile-policy.json); it does not copy or privately version upstream implementations. Lifecycle's `SurfaceExperiencePack` is currently a development-only read adapter candidate and is not part of the admitted runtime dependency set.

Use the source profile explicitly when comparing commands:

```sh
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE help
```

Release artifact-only selection is intentionally blocked until the accountable publishers provide all required records:

```sh
./gradlew -Pghatana.media.dependencyProfile=RELEASE_ARTIFACT_ONLY help
```

For Node and other package managers, workspace packages remain development bindings. [The release dependency inventory](../implementation/verification/post-pdp-2026-10-12.json) and dependency inventory generator must show an installed consumer without sibling source substitution before release claims are considered.
