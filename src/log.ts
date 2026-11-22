/**
 * Minimal structured logger (one JSON object per line).
 *
 * Rules enforced by callers and backed up here:
 * - message bodies are never logged at info level or above;
 * - private keys and tokens are never logged at any level. As a backstop,
 *   fields whose names look secret are redacted before writing.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_FIELD = /(private|secret|token|password|pass|authorization|cookie|seed)/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(key)) out[key] = '[redacted]';
    else if (value instanceof Error) out[key] = value.message;
    else out[key] = value;
  }
  return out;
}

export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...(fields ? redact(fields) : {}) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent');

export function parseLogLevel(value: string | undefined): LogLevel {
  return value && value in ORDER ? (value as LogLevel) : 'info';
}
