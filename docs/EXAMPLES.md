# Media examples

These examples exercise deterministic local fixtures and source projections.
They do not call a Media runtime, transfer bytes, invoke a provider, or create
acceptance evidence.

## Validate the Product Definition source tree

```sh
pnpm check:product-experience-local
```

The check validates the 147-record Explorer index, 462 capability leaves,
component/screen/journey/action cross-references, proposal-only action guards,
closure-matrix coverage, and the intentional absence of hand-authored
`currentness.yaml`.

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
relations, and pending Tools currentness without generating acceptance or
runtime evidence.
