import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';

export interface RouteDeps {
  db: Pick<pg.Pool, 'query'>;
}

/**
 * Service routes, versioned under /v1. Health/readiness live in service-kit.
 * Keep handlers thin: parse → call domain/ → map result to HTTP.
 */
export const routes: FastifyPluginAsync<RouteDeps> = async (app, { db }) => {
  // Example route that touches the DB. Useful for the Phase 0 break-it:
  // restart Postgres while the service runs, then hit this again.
  app.get('/v1/db-time', async () => {
    const { rows } = await db.query<{ now: Date }>('select now() as now');
    return { now: rows[0]?.now.toISOString() };
  });
};
