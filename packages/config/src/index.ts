import { z } from 'zod';

/**
 * Env vars every service needs. Services extend this:
 *
 *   const envSchema = baseEnvSchema.extend({ DATABASE_URL: z.url() });
 *   export const env = loadEnv(envSchema);
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  // 0.0.0.0, not 127.0.0.1: inside a container, loopback is the container itself,
  // so a server bound to 127.0.0.1 is unreachable through a published port.
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Must stay below Docker's stop timeout (10s default) or SIGKILL lands first.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Boolean env flag. Do NOT use z.coerce.boolean(): it is Boolean(value), and
 * Boolean("false") === true.
 */
export const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

/** Comma-separated list, e.g. KAFKA_BROKERS=a:9092,b:9092 */
export const envList = () =>
  z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1));

export class EnvValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(`Invalid environment configuration:\n${z.prettifyError(error)}`);
    this.name = 'EnvValidationError';
    this.issues = error.issues;
  }
}

type EnvSource = Record<string, string | undefined>;

/**
 * Validate `source` against `schema`. Throws EnvValidationError listing EVERY
 * problem at once, so you don't fix-and-restart one var at a time.
 *
 * Empty strings are treated as unset: `PORT=` in a .env file yields "", and
 * z.coerce.number("") is 0, which would silently pass a lenient schema.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: EnvSource = process.env,
): Readonly<z.output<S>> {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) throw new EnvValidationError(result.error);
  return Object.freeze(result.data);
}

/**
 * parseEnv for service entrypoints: on failure, print every issue and exit(1)
 * before anything else boots. A deploy with bad config should fail loudly at
 * startup, not on the first request that touches the missing value.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: EnvSource = process.env,
): Readonly<z.output<S>> {
  try {
    return parseEnv(schema, source);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export { z };
