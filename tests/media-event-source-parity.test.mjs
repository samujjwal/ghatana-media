import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const registryPath = ".product-experience/pdp-3-product-experience/events/event-registry.yaml";
const domainEventsPath = ".product-experience/pdp-1-domain-data/events.yaml";
const conventionsPath = ".product-experience/pdp-2-design-interface-system/events/conventions.yaml";
const runtimePath = "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java";
const publisherPath = "launcher/src/main/java/com/ghatana/media/launcher/MediaLifecyclePublisher.java";
const clientPath = "libs/audio-video-client/src/index.ts";
const read = (path) => readFileSync(path, "utf8");

const lifecycleTypes = [
  "media.upload.started",
  "media.artifact.completed",
  "media.job.accepted",
  "media.job.cancelled",
  "media.job.cancel_requested",
  "media.stream.opened",
  "media.stream.closed",
  "media.job.completed",
  "media.job.failed",
];

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end < 0 ? undefined : end);
}

function validate({ registry, domainEvents, conventions, runtime, publisher, client }) {
  const errors = [];
  const runtimePopulation = section(registry, "  runtimeLifecyclePublisherTypes:\n", "  clientLocalTypeScriptNotifications:\n");
  const registeredRuntimeTypes = [...runtimePopulation.matchAll(/^      - (media\.[^\s]+)$/gmu)].map(([, id]) => id);
  const sourceInventory = section(domainEvents, "  lifecyclePublisherInventory:\n", "  clientNotificationInventory:\n");
  const sourceClientInventory = section(domainEvents, "  clientNotificationInventory:\n", "  excludedEventShapedSources:\n");
  const inventoryRuntimeTypes = [...sourceInventory.matchAll(/^      - \{eventType: (media\.[^,}]+),/gmu)].map(([, id]) => id);
  const conventionsRuntimePopulation = section(conventions, "  runtimeLifecyclePublishers:\n", "  clientLocalNotifications:\n");
  const conventionTypes = [...conventionsRuntimePopulation.matchAll(/^      - (media\.[^\s]+)$/gmu)].map(([, id]) => id);

  const runtimeCrosswalk = [...sourceInventory.matchAll(/^      - \{eventType: (media\.[^,}]+), callSite: "([^"]+)", sourceRef: "([^"]+)", publisherCallSite: \{identity: ([^,}]+), sourcePath: ([^}]+)\}, observedPayloadFields: \[([^\]]*)\]/gmu)]
    .map(([, eventType, callSite, sourceRef, publisher, sourcePath, fields]) => ({
      eventType, callSite, sourceRef, publisher, sourcePath, fields: fields.split(", "),
    }));
  const clientCrosswalk = [...sourceClientInventory.matchAll(/^      - \{eventName: "([^"]+)", publisherCallSite: ([^,]+), observedPayloadFields: \[([^\]]*)\], sourceRef: "([^"]+)"\}/gmu)]
    .map(([, eventName, publisher, fields, sourceRef]) => ({ eventName, publisher, fields: fields.split(", "), sourceRef }));
  const expectedRuntimeCrosswalk = [
    ["media.upload.started", "MediaRuntime#beginUpload", "MediaRuntime#beginUpload", ["contentType", "expectedSizeBytes"]],
    ["media.artifact.completed", "MediaRuntime#completeUpload", "MediaRuntime#completeUpload", ["contentType", "sizeBytes", "sourceUploadId", "sha256"]],
    ["media.job.accepted", "MediaRuntime#submitJob", "MediaRuntime#submitJob", ["artifactId", "jobType", "providerId", "status"]],
    ["media.job.cancelled", "MediaRuntime#cancel", "MediaRuntime#cancel", ["artifactId", "jobType", "providerId", "status", "cancellationOutcome"]],
    ["media.job.cancel_requested", "MediaRuntime#cancel", "MediaRuntime#cancel", ["artifactId", "jobType", "providerId", "status", "cancellationOutcome"]],
    ["media.stream.opened", "MediaRuntime#openStream", "MediaRuntime#openStream", ["streamKind", "providerId"]],
    ["media.stream.closed", "MediaRuntime#closeStream", "MediaRuntime#closeStream", ["streamKind", "providerId", "lastSequence", "state"]],
    ["media.job.completed", "MediaRuntime#startJob terminal publication", "MediaRuntime#startJob-terminal-publication", ["artifactId", "jobType", "providerId", "status", "failureCode"]],
    ["media.job.failed", "MediaRuntime#startJob terminal publication", "MediaRuntime#startJob-terminal-publication", ["artifactId", "jobType", "providerId", "status", "failureCode"]],
  ];
  const expectedClientPublishers = new Map([
    ["stt:transcription", "AudioVideoClient#transcribe"], ["tts:synthesis", "AudioVideoClient#synthesize"],
    ["ai-voice:process", "AudioVideoClient#processAIVoice"], ["vision:process", "AudioVideoClient#processVision"],
    ["multimodal:process", "AudioVideoClient#processMultimodal"],
  ]);
  const sourceExcerpt = (source, sourceRef) => {
    const match = sourceRef.match(/#L(\d+)(?:-L(\d+))?$/u);
    if (!match) return "";
    return source.split("\n").slice(Number(match[1]) - 1, Number(match[2] ?? match[1])).join("\n");
  };

  if (!runtimePopulation.includes("count: 9")) errors.push("runtime lifecycle population count must remain 9");
  for (const [label, values] of [["registry", registeredRuntimeTypes], ["PDP1", inventoryRuntimeTypes], ["PDP2", conventionTypes]]) {
    if (values.length !== 9 || new Set(values).size !== 9 || values.join("\n") !== lifecycleTypes.join("\n")) {
      errors.push(`${label} runtime event inventory must contain the exact nine source-observed identities once`);
    }
  }

  const expectedSourceTypes = [
    "media.upload.started", "media.artifact.completed", "media.job.accepted",
    "media.job.cancelled", "media.job.cancel_requested", "media.stream.opened", "media.stream.closed",
  ];
  for (const id of expectedSourceTypes) if (!runtime.includes(`"${id}"`)) errors.push(`runtime source no longer contains exact event identity ${id}`);
  if (!runtime.includes('"media.job." + terminal.status().name().toLowerCase(java.util.Locale.ROOT)')) errors.push("terminal event identity must remain dynamically sourced from terminal job status");
  if (!runtime.includes("JobStatus.COMPLETED") || !runtime.includes("JobStatus.FAILED")) errors.push("terminal source must establish only completed and failed concrete statuses");
  if ([...runtime.matchAll(/publishLifecycle\(/gu)].length - 1 !== 7) errors.push("runtime call-site denominator must remain seven plus the method declaration");
  if (runtimeCrosswalk.length !== 9 || new Set(runtimeCrosswalk.map(({ eventType }) => eventType)).size !== 9
      || runtimeCrosswalk.map(({ eventType }) => eventType).join("\n") !== lifecycleTypes.join("\n")) {
    errors.push("PDP1 runtime source crosswalk must contain the exact nine event identities once");
  }
  if (runtimeCrosswalk.length !== expectedRuntimeCrosswalk.length || runtimeCrosswalk.some((row, index) => {
    const [type, callSite, publisher, fields] = expectedRuntimeCrosswalk[index] ?? [];
    const excerpt = sourceExcerpt(runtime, row.sourceRef);
    return row.eventType !== type || row.callSite !== callSite || row.publisher !== publisher
      || row.sourcePath !== "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java"
      || row.fields.join(",") !== fields?.join(",") || !row.sourceRef.startsWith(`${row.sourcePath}#L`)
      || fields?.some((field) => !excerpt.includes(`"${field}"`))
      || (type.startsWith("media.job.") && callSite.includes("terminal")
        ? !excerpt.includes('"media.job." + terminal.status()')
        : !excerpt.includes(`"${type}"`));
  })) errors.push("PDP1 runtime event/publisher/payload crosswalk must match direct Runtime source call sites");
  if (new Set(runtimeCrosswalk.map(({ publisher }) => publisher)).size !== 7) errors.push("PDP1 runtime publisher call-site identities must contain seven distinct source call sites");

  const observedClientEvents = [...client.matchAll(/emitEvent\('([^']+)'/gu)].map(([, name]) => name);
  const clientPopulation = section(registry, "  clientLocalTypeScriptNotifications:\n", "events:\n");
  const eventRecords = [...registry.matchAll(/^  - id: (media\.event\.[^\s]+)\n    eventName: "([^"]+)"/gmu)].map(([, id, name]) => ({ id, name }));
  const registryNames = eventRecords.map(({ name }) => name);
  const registryIds = eventRecords.map(({ id }) => id);
  if (observedClientEvents.length !== 15 || new Set(observedClientEvents).size !== 15) errors.push("client source must emit the exact 15 unique local notifications");
  if (!clientPopulation.includes("count: 15")) errors.push("client registry population must contain the exact 15 unique names");
  if (registryNames.length !== 15 || new Set(registryNames).size !== 15) errors.push("client registry population must contain the exact 15 unique names");
  if ([...observedClientEvents].sort().join("\n") !== [...registryNames].sort().join("\n")) errors.push("client registry names must match source-emitted local notifications exactly");
  if (registryIds.length !== 15 || new Set(registryIds).size !== 15 || registryIds.some((id) => !registryNames.includes(id.slice("media.event.".length)))) {
    errors.push("public event IDs must bind one-to-one to the 15 client-local names only");
  }
  const clientNamesInSourceOrder = [...client.matchAll(/emitEvent\('([^']+)'/gu)].map(([, name]) => name);
  if (clientCrosswalk.length !== 15 || new Set(clientCrosswalk.map(({ eventName }) => eventName)).size !== 15
      || clientCrosswalk.map(({ eventName }) => eventName).join("\n") !== clientNamesInSourceOrder.join("\n")) {
    errors.push("PDP1 client source crosswalk must contain the exact 15 notification identities once in source order");
  }
  if (clientCrosswalk.some(({ eventName, publisher, fields, sourceRef }) => {
    const family = eventName.split(":").slice(0, 2).join(":");
    const phase = eventName.split(":").at(-1);
    const expectedFields = phase === "start" ? ["request"] : phase === "complete" ? ["request", "result"] : ["request", "error"];
    const excerpt = sourceExcerpt(client, sourceRef);
    return publisher !== expectedClientPublishers.get(family) || fields.join(",") !== expectedFields.join(",")
      || !sourceRef.startsWith("libs/audio-video-client/src/index.ts#L")
      || !excerpt.includes(`'${eventName}'`)
      || fields.some((field) => !excerpt.includes(field));
  })) errors.push("PDP1 client notification/publisher/payload crosswalk must match direct AudioVideoClient source");
  if (new Set(clientCrosswalk.map(({ publisher }) => publisher)).size !== 5) errors.push("PDP1 client publisher identities must contain five distinct source methods");
  if (!client.includes("listeners.forEach(callback => {") || !client.includes("try { callback(data); } catch (error)")) errors.push("client listener dispatch must retain source-observed callback isolation");

  if (!runtimePopulation.includes("classification: observed server-side publisher implementation types; not an accepted canonical taxonomy")) errors.push("runtime event population must remain implementation inventory, not canonical taxonomy");
  if (!runtimePopulation.includes("deliveryFinalityOrderingReplayGuarantees: not-established")) errors.push("runtime delivery/finality/ordering/replay guarantees must remain not established");
  if (!registry.includes("deliveryFinalityOrderingReplayGuarantees: not-established")) errors.push("client-local delivery/finality/ordering/replay guarantees must remain not established");
  if (!registry.includes("status: implementation-observed; not-an-accepted-delivery-contract")) errors.push("runtime delivery claims must remain implementation observations");
  for (const marker of ["readyFalse: publication-skipped", "transport: bounded-synchronous-http-post", "acceptedHttpStatuses: [200, 201]", "otherHttpStatus: publisher-throws", "runtimeFailure: logs-publication-unconfirmed-and-continues"]) {
    if (!runtimePopulation.includes(marker)) errors.push(`runtime delivery observation missing ${marker}`);
  }
  if (!publisher.includes('.header("Idempotency-Key", event.eventId())')) errors.push("publisher source no longer sets Idempotency-Key from eventId");
  if (!registry.includes("durableDeduplication: unverified")) errors.push("Idempotency-Key must not imply durable deduplication");
  for (const marker of ["durable-outbox", "retry-policy", "replay", "retention", "ordering", "delivery-cardinality", "consumer-acknowledgement", "recovery"]) {
    if (!runtimePopulation.includes(marker)) errors.push(`unproven delivery guarantee ${marker} must remain explicitly not established`);
  }
  if (!registry.includes("status: two-observed-source-populations; event-taxonomy-and-domain-lifecycle-coverage-pending-owner-review")) errors.push("taxonomy and domain lifecycle coverage must remain pending owner review");
  if (!registry.includes("semanticCrosswalk: not-established")) errors.push("cross-population semantic crosswalk must remain unresolved");
  return errors;
}

const base = {
  registry: read(registryPath),
  domainEvents: read(domainEventsPath),
  conventions: read(conventionsPath),
  runtime: read(runtimePath),
  publisher: read(publisherPath),
  client: read(clientPath),
};

test("event registry binds exact runtime and client source populations while preserving unproven guarantees", () => {
  assert.deepEqual(validate(base), []);
});

test("event source parity rejects missing, stale, or duplicated runtime identities", () => {
  const registryWithoutType = base.registry.replace("      - media.job.accepted\n", "");
  assert.match(validate({ ...base, registry: registryWithoutType }).join("\n"), /registry runtime event inventory must contain the exact nine source-observed identities once/u);
  const registryWithStaleType = base.registry.replace("      - media.job.accepted\n", "      - media.job.stale\n");
  assert.match(validate({ ...base, registry: registryWithStaleType }).join("\n"), /registry runtime event inventory must contain the exact nine source-observed identities once/u);
  const registryWithDuplicateType = base.registry.replace("      - media.job.accepted\n", "      - media.job.accepted\n      - media.job.accepted\n");
  assert.match(validate({ ...base, registry: registryWithDuplicateType }).join("\n"), /registry runtime event inventory must contain the exact nine source-observed identities once/u);
});

test("source crosswalk rejects missing, stale, or duplicate event and publisher identities", () => {
  const noRuntimeCrosswalk = base.domainEvents.replace(/      - \{eventType: media\.job\.accepted, callSite: [^\n]+\n/u, "");
  assert.match(validate({ ...base, domainEvents: noRuntimeCrosswalk }).join("\n"), /PDP1 runtime source crosswalk must contain the exact nine event identities once/u);

  const staleRuntime = base.domainEvents.replace("eventType: media.job.accepted, callSite:", "eventType: media.job.stale, callSite:");
  assert.match(validate({ ...base, domainEvents: staleRuntime }).join("\n"), /PDP1 runtime source crosswalk must contain the exact nine event identities once/u);
  const duplicateRuntime = base.domainEvents.replace("eventType: media.job.accepted, callSite:", "eventType: media.job.upload.started, callSite:");
  assert.match(validate({ ...base, domainEvents: duplicateRuntime }).join("\n"), /PDP1 runtime source crosswalk must contain the exact nine event identities once/u);

  const stalePublisher = base.domainEvents.replace("identity: MediaRuntime#submitJob", "identity: MediaRuntime#stalePublisher");
  assert.match(validate({ ...base, domainEvents: stalePublisher }).join("\n"), /runtime event\/publisher\/payload crosswalk must match direct Runtime source/u);
  const missingPublisher = base.domainEvents.replace("publisherCallSite: {identity: MediaRuntime#submitJob, sourcePath:", "publisherCallSite: {sourcePath:");
  assert.match(validate({ ...base, domainEvents: missingPublisher }).join("\n"), /runtime publisher call-site identities must contain seven distinct source call sites/u);
  const duplicatePublisher = base.domainEvents.replace("identity: MediaRuntime#submitJob", "identity: MediaRuntime#beginUpload");
  assert.match(validate({ ...base, domainEvents: duplicatePublisher }).join("\n"), /runtime publisher call-site identities must contain seven distinct source call sites/u);

  const noClientEvent = base.domainEvents.replace(/      - \{eventName: "vision:process:error"[^\n]+\n/u, "");
  assert.match(validate({ ...base, domainEvents: noClientEvent }).join("\n"), /PDP1 client source crosswalk must contain the exact 15 notification identities once/u);
  const staleClientEvent = base.domainEvents.replace('eventName: "vision:process:error"', 'eventName: "vision:process:stale"');
  assert.match(validate({ ...base, domainEvents: staleClientEvent }).join("\n"), /PDP1 client source crosswalk must contain the exact 15 notification identities once/u);
  const staleClientPublisher = base.domainEvents.replace("publisherCallSite: AudioVideoClient#processVision", "publisherCallSite: AudioVideoClient#stale");
  assert.match(validate({ ...base, domainEvents: staleClientPublisher }).join("\n"), /client notification\/publisher\/payload crosswalk must match direct AudioVideoClient source/u);
  const missingClientPublisher = base.domainEvents.replace("publisherCallSite: AudioVideoClient#processVision, observedPayloadFields:", "observedPayloadFields:");
  assert.match(validate({ ...base, domainEvents: missingClientPublisher }).join("\n"), /PDP1 client source crosswalk must contain the exact 15 notification identities once/u);
});

test("event source parity rejects local/runtime population collapse and unsupported delivery promotion", () => {
  const promotedRuntime = base.registry.replace("deliveryFinalityOrderingReplayGuarantees: not-established", "deliveryFinalityOrderingReplayGuarantees: durable-ordered-replay");
  assert.match(validate({ ...base, registry: promotedRuntime }).join("\n"), /runtime delivery\/finality\/ordering\/replay guarantees must remain not established/u);
  const promotedIdempotency = base.registry.replace("durableDeduplication: unverified", "durableDeduplication: guaranteed");
  assert.match(validate({ ...base, registry: promotedIdempotency }).join("\n"), /Idempotency-Key must not imply durable deduplication/u);
  const localCountDrift = base.registry.replace("count: 15\n    source: libs/audio-video-client/src/index.ts#AudioVideoClient", "count: 14\n    source: libs/audio-video-client/src/index.ts#AudioVideoClient");
  assert.match(validate({ ...base, registry: localCountDrift }).join("\n"), /client registry population must contain the exact 15 unique names/u);
});
