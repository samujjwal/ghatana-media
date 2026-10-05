import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMediaCancellationTruth } from '../lib/media-cancellation-truth.mjs';

const validRuntime = `
if (providerOutcome == CancellationOutcome.CONFIRMED) {}
cancellationRequested(current, providerOutcome);
"media.job.cancel_requested";
MEDIA_JOB_CANCEL_REQUESTED;
PROCESSING_CANCELLED_UNCONFIRMED;
current.status(), current.createdAt(), current.startedAt();
current.completedAt(), Map.copyOf(result);
`;
const validTest = `
unconfirmedCancellationRemainsNonTerminalAndProviderOutcomeStillWins
isEqualTo(JobStatus.RUNNING)
containsEntry("cancellationOutcome", "REQUESTED_UNCONFIRMED")
isNotCancelled()
provider-completed-after-cancel-request
confirmedCancellationIsTerminalAndCarriesProviderConfirmation
containsEntry("cancellationOutcome", "CONFIRMED")
`;
const validMigration = `
CONSTRAINT media_job_cancelled_requires_confirmation
status = 'CANCELLED'
cancellationOutcome
CONFIRMED
`;

test('accepts non-terminal uncertain cancellation authority', () => {
  assert.deepEqual(validateMediaCancellationTruth({
    runtimeSource: validRuntime,
    testSource: validTest,
    migrationSource: validMigration,
  }), []);
});

test('rejects the historical false-terminal cancellation path', () => {
  const errors = validateMediaCancellationTruth({
    runtimeSource: `${validRuntime}\n"CANCELLED_UNCONFIRMED"`,
    testSource: validTest.replace('isNotCancelled()', ''),
    migrationSource: validMigration,
  });
  assert.ok(errors.some(error => error.includes('retains forbidden "CANCELLED_UNCONFIRMED"')));
  assert.ok(errors.some(error => error.includes('isNotCancelled()')));
});
