// Compile-time only (npm run typecheck): the provider must be assignable to the real Shared port.
// Sibling-checkout layout: ../ghatana-shared next to ghatana-media. No runtime import.
import type { DocumentContentScanPort as SharedPort } from '../../../../ghatana-shared/platform/typescript/documents/src/lifecycle/ports.ts';
import type { SecurityScannerProvider } from '../src/index.ts';

export const assertAssignableToSharedPort = (provider: SecurityScannerProvider): SharedPort => provider;
