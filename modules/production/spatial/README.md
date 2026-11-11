# Bounded spatial rig evaluation

## Purpose and boundary

This module provides a deterministic CPU-side spatial pose evaluator and a bounded GLB 2.0 skeleton-animation exporter for an explicitly described skeleton, exact coordinate-frame versions, bounded keyframe tracks, and a basic perspective projection helper. It uses immutable values and a single supported local profile: `UNIT_QUATERNION_XYZW`, seconds as rational keyframe time, a camera looking along local `-Z`, and a declared signed-axis basis. Unsupported or incomplete conventions fail closed.

The spatial-frame declaration is grounded in `.product-experience/pdp-1-domain-data/value-objects.yaml#spatialTransformDeclarationContract`. The source deliberately leaves the general spatial conversion algorithm unselected. This module therefore supports only a narrow, explicit, same-position-unit signed-axis re-expression profile; it does not infer calibration, frame origins, world alignment, scale conversion, or scientific accuracy. The conversion request carries exact source/target frame versions and an ordered mapping reference; other operation sequences are rejected.

`SpatialRigEngine.evaluate` and `exportGlb` check every exact immutable source version through a caller-supplied `SourceRightsPort`. `REVOKED`, `UNKNOWN`, absent authority, and authority failures block pose/export work. The retained Boolean predicate overload is only for local compatibility; production callers must bind the typed port to authenticated current rights evidence. Export requires at least one exact source artifact version, the exact source project revision, and one explicit, local GLB profile (`+X/+Y/+Z`, right-handed, the declared metre and quaternion-unit references). There is no implicit unit or axis conversion.

The exporter writes actual GLB 2.0 scene nodes and animation accessors with bounded float32-second timing, exact rational input times retained in spatial extras, source/revision/frame metadata, SHA-256, and a 16 MiB output ceiling. Tests decode the GLB container, JSON chunk, animation accessors, and binary keyframe data. This is a portable local spatial candidate, not an admitted production renderer or codec, and float32 export is explicitly marked lossy. The PDP-1 spatial-transform contract remains declaration-validation-only; the implemented signed-axis re-expression and narrow GLB export profile are local engineering behavior, not a canonical mapping or admitted conversion. The module does not perform calibrated/world-frame alignment, general unit conversion, source reads, provider dispatch, or persistence. Pose evaluation still returns `POSE_ONLY`; neither pose nor GLB output proves source rights, scientific validity, or production qualification.

The local GLB candidate does not yet satisfy the J-28 spatial-export workflow contract: it has no source geometry-plan/target-profile registry join, exhaustive per-field transform/loss report, integrity receipt beyond the artifact SHA-256, output registration, or durable render-to-output lineage. The sandboxed `InteractiveDemoPlayer` consumes its separate authored demo manifest and does not decode GLB; spatial viewer parity, 360 projection/image orientation, and consumer receipt are unavailable and must not be inferred from the local GLB structure test. The journey's source-owned delivery operation and acknowledgment remain runtime-not-admitted.

## API and local usage

Construct an immutable `Rig` from versioned frame and source references, `Bone` declarations, and `PoseKeyframe` tracks. Call `evaluate(rig, time, rightsPort)` for a `POSE_ONLY` sample or `exportGlb(rig, rightsPort)` for bounded local bytes. The supplied `SourceRightsPort` must return `ELIGIBLE` for every exact source version; absent, unknown, revoked, or failing authority blocks the operation. Inspect `GlbArtifact` metadata and bytes as a local candidate; the digest binds those bytes but is not a delivery receipt.

## Supported requirements and improvement boundary

Current behavior covers deterministic local pose evaluation, explicit signed-axis re-expression within one position unit, and one bounded GLB skeleton-animation profile. It intentionally does not implement general frame conversion, source geometry reconstruction, 360 projection, a target-profile registry, production rights resolution, output registration, or viewer admission. Those require owner-supplied semantics and evidence; adding guessed metadata or conversions is outside the supported profile.

## Local verification

From the repository root, run the spatial engine tests and local J-13 scenario slice with:

```sh
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:modules:production:spatial:test --tests com.ghatana.media.production.spatial.SpatialRigEngineTest --tests com.ghatana.media.production.spatial.AnimationJ13LocalScenarioSliceTest --no-daemon --no-parallel --max-workers=2 --console=plain
```

These deterministic fixture tests validate local object, GLB container, manifest, rights-port, and animation-accessor behavior. They do not qualify a target profile, viewer, rights source, production encoder, or delivered output. The Lifecycle-owned Evidence Generator remains the authority for formal convergence artifacts; this module does not produce those receipts.
