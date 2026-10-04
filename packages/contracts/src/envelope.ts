import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Event type naming: `<aggregate>.<pastTenseVerb>`, lowercase, dot-separated.
 * e.g. booking.requested, seats.held, payment.succeeded, show.created
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * Wire format for every event on Kafka.
 *
 * - eventId:       unique per event. Consumers dedupe on it (Phase 2 idempotent consumer).
 * - type+version:  which payload schema applies. Additive change → same version;
 *                  rename/remove/retype a field → bump version and publish both
 *                  until every consumer has migrated.
 * - occurredAt:    when the fact happened (UTC, ISO-8601), not when it was published.
 *                  Outbox relays can publish minutes later.
 * - correlationId: ties every event in one booking flow together (= bookingId or the
 *                  originating requestId). This is what you search on during an incident.
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  type: z.string().regex(EVENT_TYPE_PATTERN),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().min(1).max(128),
  payload: z.unknown(),
});

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  eventId: string;
  type: TType;
  version: number;
  occurredAt: string;
  correlationId: string;
  payload: TPayload;
}

export interface EventMeta {
  correlationId: string;
  /** Override for deterministic ids, e.g. outbox rows that already have one. */
  eventId?: string;
  occurredAt?: Date;
}

export interface EventDefinition<
  TType extends string,
  TVersion extends number,
  TPayload extends z.ZodType,
> {
  readonly type: TType;
  readonly version: TVersion;
  readonly payloadSchema: TPayload;
  /** Build a validated envelope. Throws if the payload doesn't match the schema. */
  create(payload: z.input<TPayload>, meta: EventMeta): EventEnvelope<TType, z.output<TPayload>>;
  /** Validate an incoming message (already JSON-parsed). Throws on mismatch. */
  parse(input: unknown): EventEnvelope<TType, z.output<TPayload>>;
  /** Cheap check on type+version before full parsing, for routing in a consumer. */
  matches(input: { type: string; version: number }): boolean;
}

/**
 * Declare one versioned event contract. Producer and consumer both import the
 * same definition, so a breaking schema change fails the build in both places
 * instead of failing silently at runtime.
 *
 *   export const BookingRequestedV1 = defineEvent({
 *     type: 'booking.requested',
 *     version: 1,
 *     payload: z.object({ bookingId: z.uuid(), seatIds: z.array(z.string()).min(1) }),
 *   });
 */
export function defineEvent<
  const TType extends string,
  const TVersion extends number,
  TPayload extends z.ZodType,
>(def: {
  type: TType;
  version: TVersion;
  payload: TPayload;
}): EventDefinition<TType, TVersion, TPayload> {
  if (!EVENT_TYPE_PATTERN.test(def.type)) {
    throw new Error(`Invalid event type "${def.type}". Use <aggregate>.<pastTenseVerb>.`);
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`Invalid version ${String(def.version)} for ${def.type}`);
  }

  const schema = eventEnvelopeSchema.extend({
    type: z.literal(def.type),
    version: z.literal(def.version),
    payload: def.payload,
  });

  const parse = (input: unknown) => schema.parse(input) as EventEnvelope<TType, z.output<TPayload>>;

  return {
    type: def.type,
    version: def.version,
    payloadSchema: def.payload,
    create(payload, meta) {
      return parse({
        eventId: meta.eventId ?? randomUUID(),
        type: def.type,
        version: def.version,
        occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
        correlationId: meta.correlationId,
        payload,
      });
    },
    parse,
    matches(input) {
      return input.type === def.type && input.version === def.version;
    },
  };
}
