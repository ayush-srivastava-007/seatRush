import { describe, expect, it } from 'vitest';
import { baseEnvSchema, envBoolean, envList, EnvValidationError, parseEnv, z } from './index.js';

const base = { SERVICE_NAME: 'svc', PORT: '3000' };

describe('parseEnv', () => {
  it('coerces numbers and applies defaults', () => {
    const env = parseEnv(baseEnvSchema, base);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.NODE_ENV).toBe('development');
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(8000);
  });

  it('returns a frozen object', () => {
    const env = parseEnv(baseEnvSchema, base);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('reports every invalid var in one error', () => {
    try {
      parseEnv(baseEnvSchema, { PORT: 'abc', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const paths = (err as EnvValidationError).issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['SERVICE_NAME', 'PORT', 'LOG_LEVEL']));
    }
  });

  it('treats empty strings as unset (PORT= must not become 0)', () => {
    expect(() => parseEnv(baseEnvSchema, { ...base, PORT: '' })).toThrow(EnvValidationError);
    expect(parseEnv(baseEnvSchema, { ...base, LOG_LEVEL: '' }).LOG_LEVEL).toBe('info');
  });
});

describe('envBoolean', () => {
  const schema = z.object({ FLAG: envBoolean(true) });

  it('parses "false" as false (z.coerce.boolean would say true)', () => {
    expect(parseEnv(schema, { FLAG: 'false' }).FLAG).toBe(false);
    expect(parseEnv(schema, { FLAG: '0' }).FLAG).toBe(false);
    expect(parseEnv(schema, { FLAG: '1' }).FLAG).toBe(true);
    expect(parseEnv(schema, {}).FLAG).toBe(true);
  });

  it('rejects garbage instead of guessing', () => {
    expect(() => parseEnv(schema, { FLAG: 'yes' })).toThrow(EnvValidationError);
  });
});

describe('envList', () => {
  it('splits and trims', () => {
    const schema = z.object({ BROKERS: envList() });
    expect(parseEnv(schema, { BROKERS: 'a:9092, b:9092,' }).BROKERS).toEqual(['a:9092', 'b:9092']);
  });
});
