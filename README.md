# SeatRush

High-concurrency ticket booking platform: Node.js/TypeScript microservices, Kafka, Postgres, Redis.
Plan and phases: [`ROADMAP.md`](ROADMAP.md). Learning notes: [`docs/learning/`](docs/learning/).

## Prerequisites

- Node.js 24 (see `.nvmrc`); 22.13+ works
- pnpm 10: `corepack enable` (version pinned in `package.json`)
- Docker Desktop (WSL 2 backend on Windows)

## Quick start

```bash
pnpm install
pnpm build                      # compile shared packages (services import their dist/)
docker compose up -d --wait     # infra; returns once every container is healthy
docker compose ps               # all should say (healthy)

cp apps/template-service/.env.example apps/template-service/.env
pnpm dev                        # watch-builds packages + runs services with tsx
```

| URL                                              | What                          |
| ------------------------------------------------ | ----------------------------- |
| http://localhost:3000/health                     | template-service liveness     |
| http://localhost:3000/ready                      | template-service readiness    |
| http://localhost:8080                            | Redpanda Console (Kafka UI)   |
| http://localhost:16686                           | Jaeger (traces, Phase 6)      |
| `postgres://seatrush:seatrush@localhost:5432`    | Postgres (dbs: seatrush, inventory, booking, payment, assistant) |
| `mongodb://localhost:27017/?directConnection=true` | Mongo (single-node replica set) |
| `localhost:6379`                                 | Redis                         |
| `localhost:19092`                                | Kafka API (from your host)    |

## Commands

| Command                                 | Does                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `pnpm build`                            | Build everything (Turbo, cached)                      |
| `pnpm dev`                              | Watch mode for packages + services                    |
| `pnpm test` / `lint` / `typecheck`      | Per package, via Turbo                                |
| `pnpm check`                            | build + lint + typecheck + test (what CI runs)        |
| `pnpm format`                           | Prettier write                                        |
| `docker compose up -d --wait`           | Infra only                                            |
| `docker compose --profile apps up -d --build` | Infra + containerized services                  |
| `docker compose down` / `down -v`       | Stop / stop **and wipe all data**                     |

## Layout

```
apps/
  template-service/   copy this to start a new service
packages/
  config/             Zod env loader (the only place process.env is read)
  logger/             Pino JSON logger, request-id handling
  contracts/          versioned event envelope + event definitions
  service-kit/        Fastify factory, /health + /ready, graceful shutdown, retry
  tsconfig/           shared compiler settings
docker/               shared multi-stage Dockerfile for all Node services
infra/                Postgres init SQL, Redpanda Console config
docs/learning/        per-phase notes
```

## Creating a service from the template

1. `cp -r apps/template-service apps/<name>`, rename `"name"` in its `package.json` to `@seatrush/<name>`
2. Edit `src/config/env.ts` for the service's env vars
3. Copy the `template-service` block in `docker-compose.yml`, change `SERVICE`, ports, env
4. Add `<name>` to the `docker` job matrix in `.github/workflows/ci.yml`
5. `pnpm install`
