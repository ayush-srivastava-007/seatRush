import type { Logger } from '@seatrush/logger';
import { retry } from '@seatrush/service-kit';
import pg from 'pg';
import type { Env } from '../config/env.js';

export function createPool(env: Env, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    // Default is 0 = wait FOREVER for a free connection. Under load with an
    // exhausted pool, requests would hang instead of failing fast.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Server-side kill switch for runaway queries.
    statement_timeout: 10_000,
    // Shows up in pg_stat_activity, so you can tell which service holds which locks.
    application_name: env.SERVICE_NAME,
  });

  // When Postgres restarts, idle clients in the pool get disconnected and the
  // pool emits 'error'. An EventEmitter 'error' with no listener THROWS, which
  // crashes the process. With a listener, the pool drops the dead client and
  // opens a fresh one on the next query.
  pool.on('error', (err) => {
    logger.warn({ err }, 'idle postgres client errored; pool will replace it');
  });

  return pool;
}

/**
 * Prove Postgres is reachable before accepting traffic. Retries with jittered
 * backoff, because "container started" is not "database ready": on first boot
 * Postgres runs initdb and restarts itself before it accepts TCP connections.
 */
export async function connectWithRetry(
  pool: pg.Pool,
  attempts: number,
  logger: Logger,
): Promise<void> {
  await retry(
    async () => {
      const client = await pool.connect();
      client.release();
    },
    {
      attempts,
      onRetry: ({ attempt, delayMs, error }) => {
        // Message only: a full stack per attempt buries the signal.
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn({ attempt, of: attempts, delayMs, reason }, 'postgres unreachable, retrying');
      },
    },
  );
}
