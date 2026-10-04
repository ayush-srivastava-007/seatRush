import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, eventEnvelopeSchema } from './envelope.js';

const SeatsHeldV1 = defineEvent({
  type: 'seats.held',
  version: 1,
  payload: z.object({
    bookingId: z.uuid(),
    seatIds: z.array(z.string()).min(1),
    heldUntil: z.iso.datetime(),
  }),
});

const payload = {
  bookingId: '0b8f4c1e-6c1f-4a8e-9a54-0c1d2e3f4a5b',
  seatIds: ['A-1', 'A-2'],
  heldUntil: '2026-10-01T10:08:00.000Z',
};

describe('defineEvent', () => {
  it('creates a valid envelope with generated id and UTC timestamp', () => {
    const evt = SeatsHeldV1.create(payload, { correlationId: payload.bookingId });

    expect(eventEnvelopeSchema.parse(evt)).toBeTruthy();
    expect(evt.type).toBe('seats.held');
    expect(evt.version).toBe(1);
    expect(evt.occurredAt).toMatch(/Z$/);
    expectTypeOf(evt.payload.seatIds).toEqualTypeOf<string[]>();
  });

  it('refuses to create an event with an invalid payload', () => {
    expect(() =>
      SeatsHeldV1.create({ ...payload, seatIds: [] }, { correlationId: 'c1' }),
    ).toThrow();
  });

  it('round-trips through JSON (what Kafka actually carries)', () => {
    const evt = SeatsHeldV1.create(payload, { correlationId: 'c1' });
    const parsed = SeatsHeldV1.parse(JSON.parse(JSON.stringify(evt)));
    expect(parsed).toEqual(evt);
  });

  it('rejects a message of a different type or version', () => {
    const evt = SeatsHeldV1.create(payload, { correlationId: 'c1' });
    expect(() => SeatsHeldV1.parse({ ...evt, version: 2 })).toThrow();
    expect(() => SeatsHeldV1.parse({ ...evt, type: 'seats.released' })).toThrow();
    expect(SeatsHeldV1.matches({ type: 'seats.held', version: 2 })).toBe(false);
  });

  it('rejects badly named event types at definition time', () => {
    expect(() => defineEvent({ type: 'SeatsHeld', version: 1, payload: z.object({}) })).toThrow();
    expect(() => defineEvent({ type: 'seats.held', version: 0, payload: z.object({}) })).toThrow();
  });
});
