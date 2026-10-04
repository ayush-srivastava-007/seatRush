import { createLogger } from '@seatrush/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const logger = createLogger({ service: 'template-service', level: 'silent' });
let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
});

// Unit-level wiring test with a fake DB. Real-Postgres tests (Testcontainers)
// start in Phase 1, where concurrency is the thing under test.
describe('template-service', () => {
  it('is ready when the DB answers', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    app = buildApp({ logger, db });
    const res = await app.inject('/ready');
    expect(res.statusCode).toBe(200);
    expect(db.query).toHaveBeenCalledWith('select 1');
  });

  it('is not ready (but still live) when the DB is down', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    app = buildApp({ logger, db });
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('serves GET /v1/db-time', async () => {
    const now = new Date('2026-10-01T06:30:00.000Z');
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ now }] }) };
    app = buildApp({ logger, db });
    const res = await app.inject('/v1/db-time');
    expect(res.json()).toEqual({ now: '2026-10-01T06:30:00.000Z' });
  });
});
