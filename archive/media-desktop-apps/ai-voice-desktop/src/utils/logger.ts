export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (event: string, payload?: Record<string, unknown>) => void;
  info: (event: string, payload?: Record<string, unknown>) => void;
  warn: (event: string, payload?: Record<string, unknown>) => void;
  error: (event: string, payload?: Record<string, unknown>, error?: unknown) => void;
}

function getErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message || 'Unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const nestedRecord = nested as Record<string, unknown>;
      if (typeof nestedRecord.message === 'string' && nestedRecord.message.trim()) return nestedRecord.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function normalizeError(error: unknown): Record<string, unknown> | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    const cause = (error as unknown as { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(cause ? { cause: normalizeError(cause) ?? { message: getErrorMessage(cause) } } : {}),
    };
  }
  if (typeof error === 'object') {
    try {
      const obj = { ...((error as Record<string, unknown>) ?? {}) };
      if (typeof obj.message !== 'string' || !obj.message.trim()) {
        obj.message = getErrorMessage(error);
      }
      return obj;
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}

function isDev(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return true;
  }
}

export function createLogger(scope: string): Logger {
  const prefix = `[ai-voice][${scope}]`;

  const shouldDebug = isDev();

  const base = (level: LogLevel, event: string, payload?: Record<string, unknown>, error?: unknown) => {
    const data: Record<string, unknown> = {
      ...((payload ?? {}) as Record<string, unknown>),
    };

    const normalized = normalizeError(error);
    if (normalized) {
      data.error = normalized;
    }

    const message = `${prefix} ${event}`;

    if (level === 'debug') {
      if (!shouldDebug) return;
      console.debug(message, data);
      return;
    }

    if (level === 'info') {
      console.info(message, data);
      return;
    }

    if (level === 'warn') {
      console.warn(message, data);
      return;
    }

    console.error(message, data);
  };

  return {
    debug: (event, payload) => base('debug', event, payload),
    info: (event, payload) => base('info', event, payload),
    warn: (event, payload) => base('warn', event, payload),
    error: (event, payload, error) => base('error', event, payload, error),
  };
}

export function installGlobalErrorHandlers(logger: Logger): void {
  window.addEventListener('error', (event) => {
    logger.error('GlobalError', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    }, event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    logger.error('UnhandledRejection', {}, event.reason);
  });
}

export async function invokeWithLog<T>(
  logger: Logger,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  logger.info('Invoke:request', { command, ...(args ? { args } : {}) });
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = args ? await invoke<T>(command, args) : await invoke<T>(command);
    logger.info('Invoke:success', { command });
    return result;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const wrapped =
      error instanceof Error
        ? error
        : (() => {
            const err = new Error(errorMessage);
            (err as unknown as { cause?: unknown }).cause = error;
            return err;
          })();

    logger.error('Invoke:error', { command, errorMessage, ...(args ? { args } : {}) }, wrapped);
    throw wrapped;
  }
}
