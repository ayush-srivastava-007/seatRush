import { randomUUID } from 'node:crypto';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Human-readable output for local dev. Never in prod: pino-pretty is slow and breaks JSON parsing. */
  pretty?: boolean;
  /** Extra redact paths on top of DEFAULT_REDACT_PATHS. */
  redact?: string[];
}

/** Paths that must never reach a log line. Extend per service via `redact`. */
export const DEFAULT_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admission-token"]',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
];

/**
 * @param destination override stdout (tests). Ignored when `pretty` is set.
 */
export function createLogger(opts: CreateLoggerOptions, destination?: DestinationStream): Logger {
  const options = {
    level: opts.level ?? 'info',
    // pid is noise in containers; hostname = container id, which identifies the replica.
    base: { service: opts.service, hostname: process.env['HOSTNAME'] },
    timestamp: pino.stdTimeFunctions.isoTime,
    // "level":"info" instead of "level":30, so grep/Loki queries stay readable.
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...DEFAULT_REDACT_PATHS, ...(opts.redact ?? [])], censor: '[REDACTED]' },
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'hostname' },
          },
        }
      : {}),
  } satisfies LoggerOptions;
  return destination && !opts.pretty ? pino(options, destination) : pino(options);
}

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller-supplied id only if it looks like an id. Anything else
// (huge strings, newlines, JSON) gets replaced, so clients can't inject log lines.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Reuse the upstream request id if valid, else mint one. The gateway mints it
 * once; every downstream service propagates it, which is what lets you grep
 * one request across nine services.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value !== undefined && SAFE_ID.test(value) ? value : randomUUID();
}
