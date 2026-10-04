# SeatRush — Build Roadmap

A ticket booking platform for high-demand drops (concerts, Tatkal-style sales) where thousands of users compete for a few hundred seats.

**Guarantees the system must prove:**
1. No seat is ever sold twice.
2. Users get in fairly (virtual waiting room), and the backend survives the spike.
3. Any service can crash mid-booking, and every booking still ends in a consistent state.

**Headline results (measure, then put on the resume):**
- 10,000 concurrent users, 500 seats → exactly 500 bookings, **0 double-bookings** (k6)
- Booking-service p95 stays under **X ms** during a 10k-user spike, thanks to the waiting room
- Chaos test: kill random services during 100 bookings → **100% reach a terminal state**, and seat counts reconcile

---

## Architecture

```
                        ┌──────────────────────────────────────────┐
  Client ─────────────► │ API Gateway                              │
   (SSE for queue        │ JWT/JWKS · rate limits · circuit breaker │
    position + AI)       │ admission-token check · routing · cache │
                        └───────────────────┬──────────────────────┘
     ┌────────┬──────────┬─────────┬────────┼─────────┬───────────┐
     ▼        ▼          ▼         ▼        ▼         ▼           ▼
   Auth    Catalog   Waiting    Inventory  Booking  Payment   Assistant
  (Mongo)  (Mongo)    Room      (Postgres) (Postgres)(Postgres)(pgvector)
                     (Redis)        │         │         │         ▲
                                    └─────────┴────┬────┴─────────┘
                                                   ▼
                                  Kafka (Redpanda) ──► Notification worker
                     Redis: rate limits · cache · queue · semantic cache
          OpenTelemetry → Jaeger · Prometheus → Grafana
```

| Service | Store | Responsibility |
|---|---|---|
| gateway | Redis | Routing, JWT verify, rate limits, circuit breakers, admission-token check, SSE passthrough |
| auth | Mongo | Users, RS256 JWT, JWKS, refresh-token rotation |
| catalog | Mongo | Venues, events, shows, price tiers; emits `show.*` events |
| waiting-room | Redis | Virtual queue, admission rate control, signed admission tokens |
| inventory | Postgres | Seat maps, all-or-nothing holds with TTL, hold expiry |
| booking | Postgres | Booking state machine, saga orchestrator, outbox |
| payment | Postgres | Razorpay test mode, webhooks, refunds |
| notification | — | E-ticket email with signed QR |
| assistant | Postgres + pgvector | RAG over shows and policies, tool calling |

## Booking Flow

1. User joins the waiting room for a hot show → sees their position over SSE → gets admitted → receives an **admission token** (short JWT scoped to `showId`).
2. User selects seats → `POST /bookings` with `Idempotency-Key` + admission token → booking `PENDING` + outbox `BookingRequested`.
3. Inventory holds **all requested seats or none** (TTL 8 min) → `SeatsHeld` or `SeatsUnavailable`.
4. Payment creates a Razorpay order → user pays → webhook → `PaymentSucceeded` or `PaymentFailed`.
5. Booking `CONFIRMED` → inventory marks the seats `SOLD` → notification emails the ticket.

**Compensations:**
- Payment fails or times out → release the seats → booking `CANCELLED`.
- **Late payment** (the payment succeeds *after* the hold expired): try to re-hold the same seats; if they're gone, issue a refund.

**Booking states:** `PENDING → SEATS_HELD → PAYMENT_PENDING → CONFIRMED`, with `CANCELLED` and `REFUNDED` as terminal failure states.

---

## Stack

| Area | Choice |
|---|---|
| Runtime | Node.js LTS, TypeScript strict, ESM |
| Repo | pnpm workspaces + Turborepo |
| HTTP | Fastify + Zod |
| Postgres | Kysely (SQL-first query builder, so locking stays visible; no ORM magic) |
| Mongo | Official `mongodb` driver |
| Redis | ioredis + Lua scripts |
| Kafka | Redpanda locally; `@confluentinc/kafka-javascript` client (the kafkajs-compatible API; kafkajs itself is unmaintained) |
| Tests | Vitest, Supertest, Testcontainers |
| Load | k6 |
| Observability | Pino, OpenTelemetry, Jaeger, Prometheus, Grafana |
| Deploy | Docker Compose on a VPS, Caddy (auto HTTPS), GitHub Actions; K8s (kind + Helm) is the stretch goal |

---

## How Each Phase Works

Every phase has five parts:
- **Learn:** the concepts, explained before any code is written.
- **Build:** tasks marked 🎯 are yours to write, with hints and review. Everything else (boilerplate, config) gets scaffolded for you.
- **Break it:** build the naive version first, prove it fails, then fix it.
- **Done when:** objective, testable exit criteria.
- **Mastery questions:** interview-style questions. Answer them before moving on.

Notes for each phase go in `docs/learning/phase-N.md`: concepts, decisions and why, what broke, and your answers to the mastery questions. These become your blog posts.

---

## Phase 0 — Foundation (Week 1)

**Learn:** monorepo, Docker images vs containers, Compose networking, health checks, env validation, CI.

**Build:**
- [x] Monorepo scaffold (`apps/`, `packages/`), shared tsconfig and ESLint
- [x] `docker-compose.yml`: Postgres, Mongo, Redis, Redpanda + Redpanda Console, Jaeger, all with health checks
- [x] `packages/config`: Zod env loader
- [x] `packages/logger`: Pino with `requestId`
- [x] `packages/contracts`: event envelope (`eventId`, `type`, `version`, `occurredAt`, `correlationId`, `payload`)
- [x] Service template (Fastify, `/health`, graceful shutdown on SIGTERM)
- [x] GitHub Actions: lint, type-check, test

**Break it:** remove a health check, start a service before Postgres is ready, and watch it crash.

**Done when:** `docker compose up` reports everything healthy, and CI is green.

**Mastery questions:**
- Image vs container vs volume?
- Why is `depends_on` not enough without a health check?
- What is graceful shutdown, and why does it matter for Kafka consumers?

---

## Phase 1 — Core Services (Weeks 2–4)

### 1a. Auth
- [ ] Register and login, argon2
- [ ] RS256 access tokens (15 min), `/.well-known/jwks.json` with `kid`
- [ ] 🎯 Refresh-token rotation with **reuse detection**: reusing an old token revokes the whole token family

### 1b. Catalog
- [ ] Venues, events, shows, price tiers
- [ ] Cursor pagination
- [ ] Publish `show.created` and `show.updated` (a direct publish for now; Phase 2 moves this to the outbox)

### 1c. Inventory ⭐ (the heart of the project)
- [ ] Schema: `seats(show_id, seat_id, section, row, status AVAILABLE|HELD|SOLD, hold_id, held_until, version)`
- [ ] 🎯 **All-or-nothing hold** in a single transaction. Lock rows in **sorted `seat_id` order** to avoid deadlocks.
- [ ] 🎯 **Hold expiry sweeper** using `FOR UPDATE SKIP LOCKED`, so multiple sweeper instances are safe
- [ ] 🎯 "Best available N seats" allocation with `SKIP LOCKED`
- [ ] Per-user seat cap per show (e.g. 6), enforced in the DB

### 1d. Booking
- [ ] State machine with an explicit transition table
- [ ] 🎯 `Idempotency-Key` handling (unique constraint + stored response)

**Break it:**
- Write the naive read-then-write hold, fire 200 concurrent requests at the same seat → watch double holds happen. Then fix it.
- Lock seats in unsorted order from two transactions → trigger a Postgres deadlock error. Then fix it with sorting.

**Done when:** a Testcontainers test fires 200 parallel holds at one seat and exactly 1 succeeds. A second test with overlapping multi-seat requests produces 0 partial holds and 0 deadlocks.

**Mastery questions:**
- Pessimistic locking (`FOR UPDATE`) vs a conditional `UPDATE` vs optimistic locking (a `version` column): when would you use each?
- What is a deadlock, and why does consistent lock ordering prevent it?
- What does `SKIP LOCKED` do, and why is it perfect for job queues?
- What are the Postgres isolation levels (Read Committed, Repeatable Read, Serializable)? Which is the default, and which anomalies does each allow?
- Why store refresh tokens hashed?

---

## Phase 2 — Events + Saga (Weeks 5–6)

**Learn:** Kafka topics, partitions, keys, consumer groups, offsets, lag, and rebalances; delivery semantics; the dual-write problem; the outbox pattern; saga orchestration vs choreography; compensation; backoff, jitter, and DLQs; HMAC webhooks.

**Build:**
- [ ] Topic design; key everything by `bookingId`
- [ ] 🎯 Outbox table + relay (a polling relay using `SKIP LOCKED`)
- [ ] 🎯 Idempotent consumer helper (`processed_events` written in the same transaction as the side effect)
- [ ] 🎯 Saga orchestrator in booking: steps, compensations, and a **saga deadline** (no payment within 10 min → cancel)
- [ ] Payment: Razorpay test mode, 🎯 webhook HMAC verification, idempotent webhook handling, refunds
- [ ] 🎯 The late-payment edge case: re-hold if possible, otherwise refund
- [ ] Retry topics with backoff, a DLQ, and an admin endpoint to replay the DLQ
- [ ] Notification worker: e-ticket with a QR code containing an HMAC-signed `bookingId`
- [ ] Reconciliation query: seats `SOLD` must equal seats in `CONFIRMED` bookings

**Break it:**
- Publish outside the transaction and kill the process between the DB write and the publish → the event is lost.
- Deliver the same event twice → a double email. Then fix it with the idempotent consumer.
- Kill payment mid-flow.

**Done when:** a chaos script randomly kills services during 100 bookings. Every booking reaches `CONFIRMED`, `CANCELLED`, or `REFUNDED`, and the reconciliation query passes.

**Mastery questions:**
- Why not two-phase commit (2PC)?
- Orchestration vs choreography: tradeoffs?
- How does a partition key give per-booking ordering? What happens during a consumer rebalance?
- Exactly-once delivery vs effectively-once processing?
- Outbox polling vs CDC (Debezium): tradeoffs?

---

## Phase 3 — API Gateway + Rate Limiter (Weeks 7–8)

**Learn:** reverse proxies, rate-limit algorithms, atomicity in Redis, circuit breakers, timeouts, retry safety, cache invalidation, SSE.

**Build:**
- [ ] Declarative routing with per-route timeouts (Fastify + undici)
- [ ] JWT verification with a cached JWKS
- [ ] 🎯 Token bucket in Redis Lua (per user, with limits by plan)
- [ ] 🎯 Sliding window counter in Redis Lua (per IP, for unauthenticated routes)
- [ ] `429` responses + `Retry-After` + `X-RateLimit-*` headers
- [ ] 🎯 Circuit breaker, written yourself (then compare with `opossum`)
- [ ] Retries with jitter, GET only
- [ ] Request ID propagation
- [ ] Catalog GET caching, invalidated by `show.updated`
- [ ] SSE passthrough without buffering
- [ ] 📦 Extract the rate limiter into `packages/rate-limiter` → **publish it to npm** with a README, tests, and benchmarks

**Break it:**
- Fixed window: show the 2x burst at a window boundary.
- A non-atomic limiter (GET, then SET) on 2 gateway replicas → the limit gets exceeded.
- No timeout + a slow upstream → the gateway's connections saturate.

**Done when:** k6 against 2 gateway replicas shows limits enforced exactly, and the breaker visibly opens and recovers.

**Mastery questions:**
- Compare fixed window, sliding log, sliding counter, and token bucket.
- Why Lua instead of `MULTI/EXEC`?
- If Redis goes down, should the limiter fail open or fail closed? Why?
- Should breaker state be per-instance or shared?

---

## Phase 4 — Virtual Waiting Room (Week 9)

**Learn:** admission control, backpressure, load shedding, fairness, signed capability tokens.

**Build:**
- [ ] 🎯 Queue in a Redis sorted set (score = join time), position lookup with `ZRANK`, one slot per user
- [ ] 🎯 Admitter: releases N users per second based on booking-service capacity, and issues an **admission token** (a short JWT scoped to `showId`)
- [ ] Live queue position over SSE
- [ ] The gateway requires an admission token on booking routes for "hot" shows
- [ ] Anti-abuse: per-IP limits, one queue entry per user, a seat cap per user
- [ ] Redis AOF persistence, so the queue survives a restart

**Break it:** send 10k users directly at booking with no waiting room → watch p95 and error rates explode. Then turn the waiting room on.

**Done when:** a k6 spike of 10k users keeps booking p95 stable, produces 0 double-bookings, and admission order ≈ join order.

**Mastery questions:**
- Why a queue instead of just autoscaling?
- FIFO vs randomized lottery: which is fairer, and why?
- How does the admission token prevent queue-jumping?
- What happens to the queue if Redis restarts?

---

## Phase 5 — AI Assistant (Weeks 10–11)

**Learn:** embeddings, pgvector, HNSW, chunking, RAG, hybrid search, RRF, tool calling, semantic caching, prompt injection, evals.

**Build:**
- [ ] Consume `show.*` events → embed → upsert into pgvector (the index stays in sync automatically)
- [ ] Ingest FAQ and refund-policy docs (chunked)
- [ ] 🎯 Hybrid search (vector + Postgres full-text) merged with RRF
- [ ] Tools: `searchShows`, `checkMyBooking`, `seatAvailability`, **authorized with the user's token inside the tool**
- [ ] SSE streaming through the gateway, per-user token quota at the gateway, a semantic cache in Redis
- [ ] 🎯 An eval set of ~30 questions + a scoring script (retrieval recall@k, answer correctness)

**Mastery questions:**
- What are the tradeoffs of chunk size and overlap?
- HNSW vs IVFFlat?
- Why must authorization live in the tool code, not the prompt?
- How do you measure retrieval quality?

---

## Phase 6 — Observability, Load, Deploy (Weeks 12–13)

**Build:**
- [ ] OpenTelemetry across HTTP **and Kafka headers**, exported to Jaeger
- [ ] Prometheus + Grafana dashboard: RPS, p95, error rate, consumer lag, breaker state, queue length, active holds
- [ ] 🎯 k6 "Tatkal drop" scenario: 10k virtual users, 500 seats
- [ ] Deploy to a VPS with Compose + Caddy; GitHub Actions deploys on merge
- [ ] Stretch: K8s manifests with Helm, tested on kind
- [ ] README: architecture and saga diagrams, design decisions, k6 results, Jaeger screenshot, demo video

**Mastery questions:**
- Why p95 and not the average?
- Counter vs gauge vs histogram?
- How does trace context cross Kafka?
- Pull-based vs push-based metrics?

---

## Portfolio Checklist
- [ ] Live deployment link
- [ ] README with diagrams, design decisions, and measured results
- [ ] 2–3 minute demo video (a booking, a chaos recovery, the waiting room, the assistant)
- [ ] Rate limiter published on npm
- [ ] 2–3 blog posts written from `docs/learning/`

## Resume Bullets (fill in the measured numbers)
- Built a high-concurrency ticket booking platform (9 Node.js/TypeScript services, Kafka) with **0 double-bookings** across **10k concurrent users** competing for 500 seats (k6-verified).
- Designed a Redis virtual waiting room with signed admission tokens, holding booking-service p95 at **X ms** during 10k-user traffic spikes.
- Implemented saga orchestration with a transactional outbox and idempotent consumers; **100% of bookings** reached a consistent state under injected service failures.
- Authored and published an open-source Redis rate-limiting library (token bucket, sliding window) on npm.
- Shipped a RAG assistant (pgvector hybrid search, tool calling, SSE streaming) with per-user token quotas and semantic caching.

**Pace:** about 13 weeks at 10–15 hours a week. If time is short, Phases 0–4 plus the k6 test are the must-haves; Phase 5 comes next, and K8s is dropped first.
