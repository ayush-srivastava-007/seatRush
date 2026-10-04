import type { Logger } from '@seatrush/logger';
import { createServer, type Lifecycle } from '@seatrush/service-kit';
import type pg from 'pg';
import { routes } from './routes/index.js';

export interface AppDeps {
  logger: Logger;
  db: Pick<pg.Pool, 'query'>;
  lifecycle?: Lifecycle;
}

/**
 * Pure construction, no listen(), no process side effects. Tests call this with
 * fakes or a Testcontainers pool and drive it with app.inject().
 */
export function buildApp({ logger, db, lifecycle }: AppDeps) {
  const app = createServer({
    logger,
    ...(lifecycle ? { lifecycle } : {}),
    readinessChecks: {
      postgres: () => db.query('select 1'),
    },
  });

  void app.register(routes, { db });

  return app;
}
