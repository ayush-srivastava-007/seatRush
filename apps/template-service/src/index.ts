import { createLogger } from '@seatrush/logger';
import { Lifecycle, startServer } from '@seatrush/service-kit';
import { buildApp } from './app.js';
import { loadServiceEnv } from './config/env.js';
import { connectWithRetry, createPool } from './db/postgres.js';

// 1. Config. Exits(1) with every problem listed if invalid. Nothing else runs first.
const env = loadServiceEnv();

const logger = createLogger({
  service: env.SERVICE_NAME,
  level: env.LOG_LEVEL,
  pretty: env.LOG_PRETTY,
});

const lifecycle = new Lifecycle({ logger, shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS });
lifecycle.installSignalHandlers();

async function main(): Promise<void> {
  // 2. Dependencies, in order. Each registers its close hook right after it opens.
  //    Hooks run LIFO, so these close AFTER the HTTP server has drained.
  const pool = createPool(env, logger);
  lifecycle.onShutdown('postgres', () => pool.end());
  await connectWithRetry(pool, env.DB_CONNECT_MAX_ATTEMPTS, logger);
  logger.info('postgres connected');

  // (Phase 2: Kafka producer/consumer connect here, before the server.)

  // 3. HTTP server LAST, so it's the FIRST thing closed on SIGTERM.
  const app = buildApp({ logger, db: pool, lifecycle });
  await startServer(app, { host: env.HOST, port: env.PORT, lifecycle });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'startup failed');
  void lifecycle.shutdown('startup failed', 1);
});
