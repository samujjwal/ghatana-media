# Media examples

These examples exercise deterministic local fixtures and source projections.
They do not call a Media runtime, transfer bytes, invoke a provider, or create
acceptance evidence.

## Validate the Product Definition source tree

After editing authored Product Definition records, regenerate the source
manifest and Explorer index from their source:

```sh
pnpm generate:product-definition-manifest
```

The generator owns `.product-experience/source-manifest.yaml` and
`apps/media-experience-explorer/specification-artifacts.json`; do not edit those
generated files manually.

```sh
pnpm check:product-experience-local
```

The check validates the generated Explorer index, capability and component
records, screen/journey/action references, proposal-only action guards,
closure-matrix coverage, and the intentional absence of hand-authored
`currentness.yaml`. It is structural local validation, not semantic acceptance
or generated currentness.

## Run the deterministic command simulator

```sh
node libs/media-experience-simulation/bin/ghatana-media.mjs \
  --scenario media.scenario.job-outcome-unknown \
  job check-outcome \
  --job fixture-transcription-job-unknown \
  --format json
```

The result preserves the existing job identity and reports an unknown outcome;
it does not dispatch new work. The fixture runner and canonical command
simulator both use synthetic state only.

## Review the browser projection

```sh
pnpm dlx vite@7.3.1 --config apps/media-experience-explorer/vite.config.mjs
```

Use Specification mode to inspect source-linked phase records and Product mode
to inspect a disabled proposal route. The Explorer displays canonical paths,
relations, and pending lifecycle currentness without generating acceptance or
runtime evidence.
