import type { Logger } from '@seatrush/logger';

type ShutdownHook = { name: string; fn: () => Promise<void> | void };

export interface LifecycleOptions {
  logger: Logger;
  /** Hard deadline for all hooks. Keep it below the orchestrator's kill timeout. */
  shutdownTimeoutMs: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

/**
 * Owns process shutdown.
 *
 * Hooks run in REVERSE registration order (LIFO), so whatever you opened first
 * closes last. Register in startup order:
 *   1. DB pool          → closed 3rd
 *   2. Kafka consumer   → closed 2nd (commits offsets, leaves the group)
 *   3. HTTP server      → closed 1st (stops accepting, drains in-flight requests)
 *
 * That way no in-flight request is left holding a DB connection that just closed.
 */
export class Lifecycle {
  private readonly hooks: ShutdownHook[] = [];
  private shutdownPromise: Promise<void> | null = null;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly exit: (code: number) => void;

  constructor(opts: LifecycleOptions) {
    this.logger = opts.logger;
    this.timeoutMs = opts.shutdownTimeoutMs;
    this.exit = opts.exit ?? ((code) => process.exit(code));
  }

  get isShuttingDown(): boolean {
    return this.shutdownPromise !== null;
  }

  onShutdown(name: string, fn: () => Promise<void> | void): void {
    this.hooks.push({ name, fn });
  }

  /** Idempotent: a second call returns the shutdown already in progress. */
  shutdown(reason: string, exitCode = 0): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(reason, exitCode);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: string, exitCode: number): Promise<void> {
    this.logger.info({ reason }, 'shutdown started');

    // Safety net: a hung hook (stuck query, broker unreachable) must not keep
    // the process alive until SIGKILL. unref() so the timer itself never
    // holds the event loop open.
    const timer = setTimeout(() => {
      this.logger.fatal({ timeoutMs: this.timeoutMs }, 'shutdown timed out, forcing exit');
      this.exit(1);
    }, this.timeoutMs);
    timer.unref();

    let code = exitCode;
    for (const hook of [...this.hooks].reverse()) {
      try {
        await hook.fn();
        this.logger.info({ hook: hook.name }, 'closed');
      } catch (err) {
        code = 1;
        this.logger.error({ err, hook: hook.name }, 'error during shutdown');
      }
    }

    clearTimeout(timer);
    this.logger.info({ exitCode: code }, 'shutdown complete');
    this.exit(code);
  }

  /**
   * SIGTERM: what `docker stop` / Kubernetes send. SIGINT: Ctrl+C.
   * A second signal while shutting down forces an immediate exit (impatient Ctrl+C).
   *
   * NOTE: Node running as PID 1 in a container gets no default signal handling
   * from the kernel. Without these handlers SIGTERM is ignored and Docker waits
   * the full stop timeout, then SIGKILLs. Use `init: true` in compose too.
   */
  installSignalHandlers(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (this.isShuttingDown) {
          this.logger.warn({ signal }, 'second signal, forcing exit');
          this.exit(1);
          return;
        }
        void this.shutdown(signal);
      });
    }

    // After an uncaught error the process state is unknown. Try to close
    // cleanly (bounded by the timeout), then exit non-zero so the orchestrator restarts us.
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaught exception');
      void this.shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ err: reason }, 'unhandled rejection');
      void this.shutdown('unhandledRejection', 1);
    });
  }
}
