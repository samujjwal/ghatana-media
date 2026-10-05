export function validateMediaCancellationTruth({ runtimeSource, testSource, migrationSource }) {
  const errors = [];
  require(errors, 'MediaRuntime', runtimeSource, [
    'providerOutcome == CancellationOutcome.CONFIRMED',
    'cancellationRequested(current, providerOutcome)',
    '"media.job.cancel_requested"',
    'MEDIA_JOB_CANCEL_REQUESTED',
    'PROCESSING_CANCELLED_UNCONFIRMED',
    'current.status(), current.createdAt(), current.startedAt()',
    'current.completedAt(), Map.copyOf(result)',
  ]);
  forbid(errors, 'MediaRuntime', runtimeSource, [
    '"CANCELLED_UNCONFIRMED"',
    'confirmed ? "CANCELLED" :',
  ]);

  require(errors, 'Media cancellation regression test', testSource, [
    'unconfirmedCancellationRemainsNonTerminalAndProviderOutcomeStillWins',
    'isEqualTo(JobStatus.RUNNING)',
    'containsEntry("cancellationOutcome", "REQUESTED_UNCONFIRMED")',
    'isNotCancelled()',
    'provider-completed-after-cancel-request',
    'confirmedCancellationIsTerminalAndCarriesProviderConfirmation',
    'containsEntry("cancellationOutcome", "CONFIRMED")',
  ]);

  require(errors, 'Media cancellation migration', migrationSource, [
    'media_job_cancelled_requires_confirmation',
    "status = 'CANCELLED'",
    "cancellationOutcome",
    "CONFIRMED",
  ]);
  return errors;
}

function require(errors, owner, source, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) errors.push(`${owner} missing ${token}`);
  }
}

function forbid(errors, owner, source, tokens) {
  for (const token of tokens) {
    if (source.includes(token)) errors.push(`${owner} retains forbidden ${token}`);
  }
}
