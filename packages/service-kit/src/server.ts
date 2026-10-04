import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { REQUEST_ID_HEADER, resolveRequestId, type Logger } from '@seatrush/logger';
import type { Lifecycle } from './lifecycle.js';

/** Resolves if the dependency is usable, throws otherwise. */
export type ReadinessCheck = () => Promise<unknown>;

export interface CreateServerOptions {
  logger: Logger;
  lifecycle?: Lifecycle;
  /** Dependencies that must be reachable to serve traffic, e.g. { postgres: () => pool.query('select 1') } */
  readinessChecks?: Record<string, ReadinessCheck>;
  /** Per-check timeout. A probe that hangs is worse than one that fails. */
  readinessTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Fastify with the SeatRush defaults:
 * - requestId taken from x-request-id (if sane) or minted, logged on every line, echoed back
 * - GET /health  = LIVENESS:  "is the process alive?" Never checks dependencies.
 * - GET /ready   = READINESS: "can I serve traffic right now?" Checks dependencies,
 *                  and flips to 503 the moment shutdown starts.
 *
 * Why the split matters: if liveness checked Postgres, one DB blip would make
 * every service fail liveness at once and the orchestrator would restart
 * all of them together. That's a self-inflicted outage. Readiness failing only
 * takes the instance out of rotation until the dependency recovers.
 */
/**
 * Fastify logs two lines per request by default ("incoming request" and
 * "request completed"). Demote the first to debug and put method/url on the
 * completed line instead: one line per request with everything you need.
 */
class SeatRushLogController extends LogController {
  constructor() {
    super({ requestIdLogLabel: 'requestId' });
  }

  override incomingRequest(request: FastifyRequest, _reply: FastifyReply): void {
    request.log.debug({ req: request }, 'incoming request');
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const fields = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTimeMs: Math.round(reply.elapsedTime * 100) / 100,
    };
    if (error) reply.log.error({ ...fields, err: error }, 'request errored');
    else reply.log.info(fields, 'request completed');
  }
}

export function createServer(opts: CreateServerOptions) {
  const { logger, lifecycle, readinessChecks = {}, readinessTimeoutMs = 1_000 } = opts;

  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER]),
    logController: new SeatRushLogController(),
    // While closing, answer new requests with 503 + Connection: close instead of hanging.
    return503OnClosing: true,
  });

  app.addHook('onRequest', async (req, reply) => {
    void reply.header(REQUEST_ID_HEADER, req.id);
  });

  // Probes hit every few seconds; logging them buries real traffic.
  app.get('/health', { logLevel: 'silent' }, () => ({ status: 'ok' }));

  app.get('/ready', { logLevel: 'silent' }, async (req, reply) => {
    if (lifecycle?.isShuttingDown) {
      return reply.code(503).send({ status: 'shutting_down' });
    }

    const entries = Object.entries(readinessChecks);
    const results = await Promise.allSettled(
      entries.map(([, check]) => withTimeout(check(), readinessTimeoutMs)),
    );

    const checks: Record<string, string> = {};
    results.forEach((result, i) => {
      const name = entries[i]?.[0] ?? `check_${String(i)}`;
      if (result.status === 'fulfilled') {
        checks[name] = 'ok';
        return;
      }
      const reason: unknown = result.reason;
      checks[name] = reason instanceof Error ? reason.message : String(reason);
      req.log.warn({ check: name, err: reason }, 'readiness check failed');
    });
    const ready = results.every((r) => r.status === 'fulfilled');

    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return app;
}

export type App = ReturnType<typeof createServer>;

export interface StartOptions {
  host: string;
  port: number;
  lifecycle: Lifecycle;
}

/**
 * listen() and register app.close() as a shutdown hook. Call this LAST in
 * startup so the server is the first thing closed on shutdown.
 */
export async function startServer(
  app: App,
  { host, port, lifecycle }: StartOptions,
): Promise<void> {
  lifecycle.onShutdown('http', () => app.close());
  await app.listen({ host, port });
}
