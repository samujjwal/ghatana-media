const operationId = 'media.operation.caption-draft-write';
const has = (value, pattern) => pattern.test(String(value ?? ''));

export function validateMediaCaptionDraftDefinition({ operations, actionContracts }) {
  const issues = [];
  const op = (operations?.operations ?? []).find(({ id }) => id === operationId);
  const bindings = actionContracts?.operationSliceBindings ?? {};
  const add = (ok, message) => { if (!ok) issues.push(message); };

  add(Boolean(op), `${operationId} must remain the existing canonical operation`);
  if (!op) return issues;

  add(JSON.stringify(op.family) === JSON.stringify(['edit-caption-text', 'align-caption-timing']),
    'caption draft definition must preserve its existing operation families');
  add(op.actionRefs?.includes('media.action.correct-caption') && op.actionRefs.includes('media.action.align-caption-timing'),
    'caption draft operation must bind both existing edit actions');
  add(JSON.stringify(op.inputSemantics?.requiredFields) === JSON.stringify([
    'draftId', 'expectedDraftRevision', 'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'editKind', 'segmentId', 'edit',
  ]), 'caption edit must bind exact source, typed parent, target segment, draft, and expected revision');
  add(op.preconditions?.some((condition) => condition.includes('expectedDraftRevision-matches-current-session-local-draft')) &&
    op.preconditions.some((condition) => condition.includes('draft-source-and-parent-match-request')),
    'caption edit must compare the draft revision and reject a source or parent mismatch');
  add(JSON.stringify(op.inputSemantics?.parentVersionKindValues) === JSON.stringify(['TRANSCRIPT_VERSION', 'CAPTION_VERSION']),
    'draft parent must use the existing typed transcript or caption version identity');
  add(has(op.inputSemantics?.expectedDraftRevision, /nonnegative-safe-integer.*compare-exactly.*increments-by-one/u),
    'draft revision must use bounded compare-and-swap semantics with a single monotonic increment');
  add(JSON.stringify(op.inputSemantics?.editKindValues) === JSON.stringify(['TEXT_CORRECTION', 'TIMING_ALIGNMENT']),
    'draft edit must select exactly one supported edit kind');
  add(JSON.stringify(op.inputSemantics?.editBranches?.TEXT_CORRECTION?.requiredFields) === JSON.stringify(['text']) &&
    JSON.stringify(op.inputSemantics?.editBranches?.TEXT_CORRECTION?.allowedFields) === JSON.stringify(['text']) &&
    has(op.inputSemantics?.editBranches?.TEXT_CORRECTION?.rule, /change-only-the-target-segment-text-and-mark-it-USER_EDITED.*preserve-segment-identity-order-other-segment-origins-language-and-uncertainty.*timing-may-remain-explicitly-unavailable/u),
    'text correction must change only text and preserve omitted timing and other supplied observations');
  add(JSON.stringify(op.inputSemantics?.editBranches?.TIMING_ALIGNMENT?.requiredFields) === JSON.stringify(['startTick', 'endTick']) &&
    JSON.stringify(op.inputSemantics?.editBranches?.TIMING_ALIGNMENT?.allowedFields) === JSON.stringify(['startTick', 'endTick']) &&
    has(op.inputSemantics?.editBranches?.TIMING_ALIGNMENT?.rule, /explicit-user-values-and-authoritative-clock-metadata/u),
    'timing alignment must be exclusive and use explicit source-tick values');
  add(has(op.sourceClockRequirement, /authoritative-sourceClockId-positive-safe-integer-ticksPerSecond-and-nonnegative-safe-integer-sourceDurationTicks/u) &&
    has(op.sourceClockRequirement, /0-<=-startTick-<-endTick-<=-sourceDurationTicks/u) &&
    has(op.sourceClockRequirement, /no-unit-conversion-estimation-or-clock-inference/u),
    'timing edits must fail closed without exact authoritative clock, rate, duration, and in-range half-open ticks');
  add(has(op.effect, /atomic-session-local-draft-revision-advance.*immutable-source-and-parent-are-never-modified/u),
    'edit application must be atomic and session-local');
  const snapshot = op.draftSnapshotDefinition ?? {};
  add(snapshot.valueKind === 'session-local-caption-draft-snapshot; not-a-new-domain-object-or-durable-record',
    'draft snapshot must remain a bounded session-local value, not a new persisted domain object');
  add(has(snapshot.ownerScope, /tenantId-principalId-and-activeSessionId.*request-cannot-select-or-override-session-ownership.*source-and-typed-parent-identity-are-fixed/u),
    'draft ownership must bind the trusted active session and fixed exact lineage');
  add(snapshot.initialization?.revision === 0 &&
    has(snapshot.initialization?.source, /one-exact-currently-readable-canonical-parent.*current-derived-edit-policy/u) &&
    has(snapshot.initialization?.segmentRequirements, /stable-nonempty-unique-segmentIds-exact-text-and-explicit-origin.*preserve-source-order/u),
    'revision zero must be prepared from an authorized exact parent with stable ordered segment identities');
  add(snapshot.initialization?.timingUnion?.SOURCE_TICKS &&
    has(snapshot.initialization.timingUnion.SOURCE_TICKS, /exact-qualified-sourceClockId-ticksPerSecond-and-sourceDurationTicks/u) &&
    has(snapshot.initialization?.timingUnion?.PROVIDER_TIME_UNQUALIFIED, /original-provider-time-values-and-declared-unit.*never-relabel-as-source-ticks/u) &&
    has(snapshot.initialization?.timingUnion?.NOT_SUPPLIED, /explicit-absence.*never-infer-or-fill/u),
    'each segment timing value must preserve its tagged source tick, provider-time, or unavailable meaning');
  add(has(snapshot.initialization?.missingParentData, /block-automatic-initialization.*DRAFT_INITIALIZATION_BLOCKED.*never-segment-joined-text-generate-IDs-or-infer-language-timing-or-clock/u),
    'initialization must block when stable parent segments are missing and prohibit inferred data');
  add(has(snapshot.initialization?.clockContext, /qualified-current-mapping-bound-to-the-exact-sourceArtifactVersion.*does-not-retime-or-rewrite/u),
    'clock context must be current, exact-source-qualified, and separate from immutable observations');
  add(has(snapshot.revision, /nonnegative-safe-integer.*each-successful-edit-or-undo-advances-exactly-one.*Number\.MAX_SAFE_INTEGER.*DRAFT_REVISION_EXHAUSTED.*never-wrap-or-reuse/u),
    'draft revisions must advance monotonically and reject safe-integer exhaustion atomically');
  add(has(snapshot.undo, /same-trusted-tenant-principal-activeSessionId-draftId-and-source-parent-lineage.*exact-current-draftRevision.*new-current-revision.*no-ABA-rollback/u) &&
    has(snapshot.undo, /DRAFT_UNDO_NOT_AVAILABLE/u),
    'undo must require exact ownership/revision and restore content without rolling back identity or reusing a revision');
  add(has(snapshot.discard, /only-this-session-local-draft.*does-not-delete-or-reverse-source-parent/u),
    'discard must remain session-local and cannot reverse a source, parent, or registered version');
  add(has(snapshot.rebase, /fresh-current-policy-and-a-new-exact-typed-parent.*distinct-new-draftId-at-revision-zero.*preserve-the-old-stale-draft.*never-reparent-an-existing-draftId-or-reuse-its-revision-identity/u) &&
    has(op.version, /source-version-and-typed-parent-are-immutable-for-a-draftId.*distinct-draftId-at-revision-zero/u),
    'rebase must create a new draft identity while preserving the stale draft and preventing revision reuse');
  add(JSON.stringify(op.outputSemantics?.successFields) === JSON.stringify([
    'draftId', 'draftRevision', 'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'editKind', 'segments', 'timingAvailability', 'observedAt',
  ]), 'successful edits must return the exact draft/source/parent revision and availability snapshot');
  const output = op.outputSemantics ?? {};
  add(JSON.stringify(output.segmentItems?.requiredFields) === JSON.stringify(['segmentId', 'text', 'origin', 'timing']) &&
    JSON.stringify(output.segmentItems?.optionalFields) === JSON.stringify(['languageDisposition', 'languageTag', 'uncertaintyObservations', 'evidenceRefs']) &&
    has(output.segmentItems?.timingField, /exact-per-segment-tagged-union-identical-to-draftSnapshotDefinition\.initialization\.timingUnion.*never-flatten-or-drop/u),
    'every returned segment must preserve its own tagged timing availability and supplied content metadata');
  add(JSON.stringify(output.timingAvailabilityValues) === JSON.stringify(['NOT_SUPPLIED', 'PROVIDER_TIME_UNQUALIFIED', 'SOURCE_CLOCK_BOUND', 'MIXED']) &&
    has(output.timingAvailabilityAggregate?.NOT_SUPPLIED, /every-segment.*NOT_SUPPLIED/u) &&
    has(output.timingAvailabilityAggregate?.PROVIDER_TIME_UNQUALIFIED, /every-segment.*PROVIDER_TIME_UNQUALIFIED/u) &&
    has(output.timingAvailabilityAggregate?.SOURCE_CLOCK_BOUND, /every-segment.*SOURCE_TICKS.*all-share-one-qualified-exact-sourceArtifactVersion-sourceClockId-ticksPerSecond-and-sourceDurationTicks-tuple/u) &&
    has(output.timingAvailabilityAggregate?.MIXED, /segment-timing-tags-differ-or-source-tick-metadata-tuples-are-inconsistent.*never-promote-the-aggregate-to-SOURCE_CLOCK_BOUND/u),
    'top-level timingAvailability must be a conservative aggregate that represents mixed or inconsistent segment metadata');
  add(has(output.registrationReadiness, /aggregate-SOURCE_CLOCK_BOUND-is-only-a-summary-not-registration-eligibility.*every-explicit-segment-tick-range.*any-NOT_SUPPLIED-or-PROVIDER_TIME_UNQUALIFIED-segment-or-MIXED-aggregate-blocks-registration/u),
    'aggregate clock status must not promote partial timing to caption-registration readiness');
  add(has(output.segmentItems?.unchangedSegmentValues, /stable-segmentId-order-exact-text-origin-language-uncertainty-and-evidence/u) &&
    has(output.segmentItems.unchangedSegmentValues, /text-edit-changes-target-text-and-origin-to-USER_EDITED-only.*timing-edit-changes-target-timing-and-origin-to-USER_EDITED-only/u),
    'returned segment identity and unedited values must remain exact while the selected edit changes only its target fields');
  add(has(op.authorization, /current-trusted-tenant-and-principal.*current-source-read-and-derived-edit-policy/u),
    'edit must require current trusted identity and exact-scope read/edit authority');
  add(['PARENT_VERSION_STALE', 'DRAFT_REVISION_CONFLICT', 'DRAFT_INITIALIZATION_BLOCKED', 'DRAFT_REVISION_EXHAUSTED', 'DRAFT_UNDO_NOT_AVAILABLE', 'SOURCE_CLOCK_UNAVAILABLE', 'CAPTION_TIMING_INVALID'].every((code) => op.error?.includes(code)),
    'draft edits must distinguish stale parents/revisions, blocked initialization, revision exhaustion, missing clock, and invalid times');
  add(has(op.failure, /validation-or-policy-failure-is-atomic-and-preserves-the-prior-draft-snapshot/u),
    'failed validation or policy checks must preserve the prior draft');
  add(has(op.unknownOutcome, /inspect-the-same-session-local-draft-or-recover-the-caller-retained-snapshot.*no-remote-effect-or-automatic-replay/u),
    'unknown local result must require same-draft reconciliation and must not imply remote replay');
  add(has(op.reversibility, /session-local-draft.*never-reverses-or-deletes-parent-source-or-registered-version/u),
    'undo and discard must remain limited to the session-local draft');
  add(has(op.finality, /no-immutable-caption-registration-review-approval-delivery-or-publication/u),
    'draft editing must remain separate from registration, approval, and publication');
  add(op.transition?.transitionRefs?.length === 0 && has(op.transition?.applicability, /no-domain-transition/u),
    'draft editing must not add a domain-state transition');
  add(op.ownerDefinitionRef === '.product-experience/decision-log.md#PXD-066' && has(op.scopeStatus, /runtime-NOT_ADMITTED/u),
    'draft definition must retain PXD-066 and remain unadmitted');
  add(bindings[operationId]?.actionIntentRefs?.includes('media.action.correct-caption') &&
    bindings[operationId].actionIntentRefs.includes('media.action.align-caption-timing') &&
    has(bindings[operationId]?.disposition, /atomic-session-local-draft.*runtime-NOT_ADMITTED/u),
    'action-contract binding must match the two edit actions and preserve non-admission');
  return issues;
}
