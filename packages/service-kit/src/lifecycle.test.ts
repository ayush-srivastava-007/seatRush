import { createLogger } from '@seatrush/logger';
import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from './lifecycle.js';

const logger = createLogger({ service: 'test', level: 'silent' });

function setup(shutdownTimeoutMs = 1_000) {
  const exit = vi.fn<(code: number) => void>();
  const lifecycle = new Lifecycle({ logger, shutdownTimeoutMs, exit });
  return { exit, lifecycle };
}

describe('Lifecycle', () => {
  it('runs hooks in reverse registration order, then exits 0', async () => {
    const { exit, lifecycle } = setup();
    const order: string[] = [];
    lifecycle.onShutdown('postgres', () => {
      order.push('postgres');
    });
    lifecycle.onShutdown('kafka', () => {
      order.push('kafka');
    });
    lifecycle.onShutdown('http', () => {
      order.push('http');
    });

    await lifecycle.shutdown('SIGTERM');

    expect(order).toEqual(['http', 'kafka', 'postgres']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is idempotent: a second shutdown does not re-run hooks', async () => {
    const { exit, lifecycle } = setup();
    const hook = vi.fn();
    lifecycle.onShutdown('db', hook);

    await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGINT')]);

    expect(hook).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('keeps closing other resources when one hook throws, and exits 1', async () => {
    const { exit, lifecycle } = setup();
    const dbClose = vi.fn();
    lifecycle.onShutdown('db', dbClose);
    lifecycle.onShutdown('http', () => {
      throw new Error('boom');
    });

    await lifecycle.shutdown('SIGTERM');

    expect(dbClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit(1) if a hook hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { exit, lifecycle } = setup(500);
      lifecycle.onShutdown('stuck-consumer', () => new Promise<void>(() => undefined));

      void lifecycle.shutdown('SIGTERM');
      expect(lifecycle.isShuttingDown).toBe(true);
      await vi.advanceTimersByTimeAsync(499);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
