export interface RetryOptions {
  /** Total attempts including the first. 1 = no retry. */
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with FULL jitter: delay = random(0, min(max, base * 2^(n-1))).
 *
 * Why jitter: when Postgres restarts, every replica of every service notices at
 * the same instant. Plain exponential backoff keeps them in lockstep, so they
 * all reconnect in the same millisecond, again and again (thundering herd).
 * Randomizing spreads the reconnects across the window.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    attempts,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = opts;
  if (attempts < 1) throw new RangeError('attempts must be >= 1');

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
