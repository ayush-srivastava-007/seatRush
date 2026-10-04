import { baseEnvSchema, loadEnv, z } from '@seatrush/config';

export const envSchema = baseEnvSchema.extend({
  DATABASE_URL: z.url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // How many times to try reaching Postgres at boot before giving up.
  // Phase 0 break-it: set to 1 and remove the compose healthcheck to watch it crash.
  DB_CONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
});

export type Env = z.output<typeof envSchema>;

/** Call once from index.ts. Never read process.env anywhere else. */
export const loadServiceEnv = (): Readonly<Env> => loadEnv(envSchema);
