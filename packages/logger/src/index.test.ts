import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, resolveRequestId } from './index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, log: createLogger({ service: 'inventory', redact: ['*.cardNumber'] }, stream) };
}

describe('createLogger', () => {
  it('emits JSON with service, string level and ISO time', () => {
    const { lines, log } = capture();
    log.info({ requestId: 'r1' }, 'hello');
    expect(lines[0]).toMatchObject({
      service: 'inventory',
      level: 'info',
      requestId: 'r1',
      msg: 'hello',
    });
    expect(lines[0]?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('redacts default and extra secret paths', () => {
    const { lines, log } = capture();
    log.info({
      user: { password: 'hunter2', cardNumber: '4111' },
      req: { headers: { authorization: 'Bearer x' } },
    });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('4111');
    expect(line).not.toContain('Bearer x');
  });
});

describe('resolveRequestId', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('keeps a well-formed upstream id', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId(['abc-123', 'other'])).toBe('abc-123');
  });

  it('replaces missing or hostile ids', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
    expect(resolveRequestId('evil\n{"level":"fatal"}')).toMatch(UUID);
    expect(resolveRequestId('x'.repeat(500))).toMatch(UUID);
  });
});
