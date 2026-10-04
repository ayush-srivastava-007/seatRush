import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, retry } from './retry.js';

const noSleep = () => Promise.resolve();

describe('retry', () => {
  it('returns as soon as an attempt succeeds', async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('connected');

    await expect(retry(fn, { attempts: 5, sleep: noSleep })).resolves.toBe('connected');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('down')));
    await expect(retry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('attempts: 1 means no retry', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('down')));
    await expect(retry(fn, { attempts: 1, sleep: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry with its delay', async () => {
    const delays: number[] = [];
    const fn = vi.fn(() => Promise.reject(new Error('down')));
    await retry(fn, {
      attempts: 3,
      sleep: noSleep,
      random: () => 1,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }).catch(() => undefined);
    expect(delays).toEqual([200, 400]);
  });
});

describe('backoffDelay', () => {
  it('doubles the ceiling each attempt and caps at max', () => {
    const max = () => 1;
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 100, 1_000, max))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it('full jitter: any value in [0, ceiling)', () => {
    expect(backoffDelay(3, 100, 1_000, () => 0)).toBe(0);
    expect(backoffDelay(3, 100, 1_000, () => 0.5)).toBe(200);
  });
});
