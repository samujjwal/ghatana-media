# Audio-video observability

## Local resource profile fixture

The test-only resource profiler runs bounded local workloads at concurrency 1, 16, and 64 and
records operation p50/p95/p99, throughput, JVM process CPU time, peak JVM heap use, and peak thread
count. It emits a TSV row scoped as `local-test-workload-no-provider`, marked `NOT_ADMITTED`, with
the requested operation count, configured time budget, runtime environment, and measured-resource
caps/results. The model and corpus are `NOT_CONFIGURED`. This is a harness check, not a Media
modality benchmark or an SLO result.

Run the focused fixture from the Media repository root:

```sh
MEDIA_RESOURCE_PROFILE_OUTPUT="$PWD/build/reports/media-resource-profile.tsv" \
  ./gradlew :services:media:audio-video-observability:test \
  --tests 'com.ghatana.audiovideo.observability.performance.MediaResourceProfileHarnessTest'
```

GPU memory, native allocator memory, connection-pool size, network bytes, FFmpeg child-process
resources, model real-time factor, and video frames per second are emitted as `NOT_MEASURED` until
the owning modality or process adapter supplies those probes. Timeout cancellation is cooperative
inside this JVM; native or FFmpeg work requiring hard termination must run behind a bounded process
boundary. No model, corpus, or provider qualification is inferred from this fixture.
