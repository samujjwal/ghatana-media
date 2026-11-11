import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest does not expose afterEach globally unless globals are enabled. Keep
// each RTL test isolated even when the suite imports hooks from `vitest`.
afterEach(cleanup);
