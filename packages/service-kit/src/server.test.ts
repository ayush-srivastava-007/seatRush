import { createLogger } from '@seatrush/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lifecycle } from './lifecycle.js';
import { createServer, type App, type CreateServerOptions } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
let app: App | undefined;

function build(opts: Partial<CreateServerOptions> = {}) {
  app = createServer({ logger, ...opts });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health (liveness)', () => {
  it('is 200 even when dependencies are down', async () => {
    const res = await build({
      readinessChecks: { postgres: () => Promise.reject(new Error('ECONNREFUSED')) },
    }).inject('/health');
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /ready (readiness)', () => {
  it('is 200 when every check passes', async () => {
    const res = await build({ readinessChecks: { postgres: () => Promise.resolve() } }).inject(
      '/ready',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
  });

  it('is 503 and names the failing dependency', async () => {
    const res = await build({
      readinessChecks: {
        postgres: () => Promise.resolve(),
        redis: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    }).inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'ok', redis: 'ECONNREFUSED' },
    });
  });

  it('treats a hanging check as a failure instead of hanging the probe', async () => {
    const res = await build({
      readinessTimeoutMs: 50,
      readinessChecks: { postgres: () => new Promise(() => undefined) },
    }).inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json<{ checks: Record<string, string> }>().checks['postgres']).toMatch(/timed out/);
  });

  it('flips to 503 as soon as shutdown starts', async () => {
    const lifecycle = new Lifecycle({ logger, shutdownTimeoutMs: 1_000, exit: vi.fn() });
    const server = build({ lifecycle });
    lifecycle.onShutdown('slow', () => new Promise((r) => setTimeout(r, 50)));
    void lifecycle.shutdown('SIGTERM');

    const res = await server.inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'shutting_down' });
  });
});

describe('request id', () => {
  it('propagates a valid upstream x-request-id', async () => {
    const res = await build().inject({ url: '/health', headers: { 'x-request-id': 'req-123' } });
    expect(res.headers['x-request-id']).toBe('req-123');
  });

  it('mints one when absent', async () => {
    const res = await build().inject('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
