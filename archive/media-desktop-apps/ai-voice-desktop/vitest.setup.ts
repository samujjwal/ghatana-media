import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

Object.defineProperty(globalThis, '__aiVoiceTauriMocks', {
  value: tauriMocks,
  configurable: true,
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauriMocks.invoke(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => tauriMocks.open(...args),
  save: (...args: unknown[]) => tauriMocks.save(...args),
}));
