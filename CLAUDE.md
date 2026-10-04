# SeatRush

A high-concurrency event ticket booking platform (a monorepo of Node.js/TypeScript microservices). It is a **learning project**: the owner is a backend-focused MERN developer with about 3 years of experience, building this to master distributed systems and infrastructure concepts for their portfolio.

The full plan, phases, and checklists are in `ROADMAP.md`. Read it at the start of every session.

## Current Status
- **Phase:** 0 — scaffold complete. Pending on owner's machine: `docker compose up -d --wait` all healthy, CI green on GitHub, break-it exercise, mastery answers in `docs/learning/phase-0.md`.
- Update this line (and tick the ROADMAP checkboxes) whenever a task or phase completes.

## How We Work: Learning Mode

1. **Explain before building.** At the start of each phase, explain that phase's concepts. Skip MERN and JavaScript basics. Go deep on infrastructure, distributed systems, databases (locking, isolation), Kafka, Redis, and any complex term. Use small diagrams and concrete failure scenarios.
2. **Split the work.**
   - Claude scaffolds boilerplate: Docker, configs, CI, service templates, wiring.
   - Tasks marked 🎯 in ROADMAP.md are for the owner to write. Give hints and pseudocode, not full solutions, then review the code critically.
   - If the owner says "write it", write it, then walk through it line by line and explain every non-obvious decision.
3. **Break it first.** For every core concept, build or run the naive version, prove the failure with a test or k6, and only then implement the fix.
4. **Gate each phase.** Don't move to the next phase until its "Done when" criteria pass and the owner has answered its mastery questions. Correct wrong or shallow answers honestly.
5. **Keep notes.** At the end of each phase, help write `docs/learning/phase-N.md`: the concepts, decisions and why, what broke, and the mastery question answers.
6. **Review honestly.** Flag race conditions, missing idempotency, missing timeouts, security issues, and weak tests. Don't approve code just to keep momentum.
7. **Communication:** terse and direct. Flag real blockers rather than asking routine questions.

## Stack & Conventions
- Node.js LTS, TypeScript `strict`, ESM, pnpm workspaces + Turborepo
- Fastify for HTTP; Zod for env and request validation
- Postgres through **Kysely**, keeping SQL and locking explicit (no ORM that hides `FOR UPDATE`); Mongo through the official driver
- Redis through ioredis; atomic logic lives in Lua scripts
- Kafka: Redpanda locally, `@confluentinc/kafka-javascript` client
- Tests: Vitest, Supertest, and Testcontainers against real infrastructure (no mocking the DB for concurrency tests); k6 for load
- Logging: Pino JSON with `requestId`/`correlationId` on every line; OpenTelemetry arrives in Phase 6

**Service layout:** `apps/<service>/src/{routes,domain,db,events,config}`
- Each service **owns its database**. No cross-service DB access.

**Events:**
- Schemas live in `packages/contracts` and are versioned
- The envelope is `eventId`, `type`, `version`, `occurredAt`, `correlationId`, `payload`
- Kafka key = `bookingId` for anything booking-related

**Data conventions:**
- Money is stored as integer paise
- All timestamps are UTC
- Every mutating endpoint that a client may retry accepts an `Idempotency-Key`

## Commands
- `pnpm install` then `pnpm build`: install, compile shared packages (services import their `dist/`)
- `docker compose up -d --wait`: start the infrastructure; returns once all healthchecks pass
- `docker compose --profile apps up -d --build`: infra + containerized services
- `docker compose down -v`: stop and **wipe all data** (re-runs Postgres init SQL next time)
- `pnpm dev`: watch-build packages + run services with tsx (each service needs `apps/<svc>/.env`)
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: via Turbo
- `pnpm check`: build + lint + typecheck + test (what CI runs)

**Shared packages** (`packages/`): `config` (Zod env, only place reading `process.env`), `logger` (Pino, request ids), `contracts` (`defineEvent` + envelope), `service-kit` (`createServer` with `/health` + `/ready`, `Lifecycle` for LIFO graceful shutdown, `retry` with full jitter), `tsconfig`. New services start as a copy of `apps/template-service`; steps in README.md.
