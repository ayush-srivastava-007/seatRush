# Phase 0: Foundation

Status: scaffolded and verified in isolation (lint, typecheck, 36 tests, prod build, real-Postgres
run). Remaining: `docker compose up` healthy on your machine, CI green on GitHub, the break-it
exercise, and your mastery answers at the bottom.

---

## 1. Monorepo: pnpm workspaces + Turborepo

- **pnpm workspaces**: `"@seatrush/logger": "workspace:*"` symlinks the local package into a
  consumer's `node_modules`. One lockfile, one store, no publishing.
- **Why it matters here**: producer and consumer import the same event definition from
  `packages/contracts`. A breaking schema change fails the *build* of both, instead of failing
  silently at runtime in a consumer that drops fields.
- **pnpm is strict**: a package can only import what's in its own `package.json`. Hit this during
  scaffolding: `template-service` imported `fastify` types while only `service-kit` depended on
  it, and typecheck failed. npm/yarn hoisting would have hidden that ("phantom dependency"), and it
  would have broken later inside the pruned Docker image.
- **Turborepo** adds a task graph and content-hash caching:
  - `"dependsOn": ["^build"]`: build my workspace dependencies first (`^` = upstream).
  - Turbo hashes a task's inputs (source, deps' hashes, lockfile slice). Same hash means the cached
    output and logs are replayed instead of re-running.

**Decision: shared packages compile to `dist/` with an `exports` map** (not raw TS source).
They behave exactly like npm packages, which matters for Docker images and for publishing
`rate-limiter` in Phase 3. The cost is a watch-build in dev (`pnpm dev` runs `tsc --watch` per
package).

**Decision: shared tsconfig lives in `packages/tsconfig`**, not a root file. `turbo prune` (used by
the Dockerfile) only copies workspaces and the root manifest, so a root `tsconfig.base.json` would
be missing inside the image build.

## 2. Images, containers, volumes

```
Image      read-only stack of content-addressed layers + metadata (CMD, ENV, USER)
Container  image + thin writable layer + a process in its own namespaces/cgroups
Volume     storage that lives outside the container's layer stack
```

- A container **is a process**. When PID 1 exits, the container stops.
- The writable layer dies with the container. DB data lives in named volumes, which survive
  `docker compose down`. They do **not** survive `down -v`.
- **Layer cache dictates Dockerfile order.** `docker/node-service.Dockerfile` copies manifests +
  lockfile → `pnpm install` → *then* source. A code change reuses the install layer.
- **Multi-stage**: the build stage has pnpm, TypeScript, and dev deps. The runtime stage is
  `node:alpine` + `dist/` + prod `node_modules` (~25 MB of app). It runs as the `node` user,
  never root.
- `.dockerignore` excludes `node_modules`. On Windows, host `node_modules` contains Windows
  binaries that would break inside a Linux image.

## 3. Compose networking

- One bridge network per compose project. **Service name = hostname** via Docker's embedded DNS.
- `localhost` inside a container is the container itself. That's why compose sets
  `DATABASE_URL=...@postgres:5432` while `.env` for `pnpm dev` uses `@localhost:5432`.
- `ports:` publishes to the **host** only. Container-to-container traffic doesn't need it.
- Servers must bind `0.0.0.0` in containers. If bound to `127.0.0.1`, the published port reaches
  nothing.
- **Kafka advertised listeners.** A client bootstraps, receives the broker's *advertised* address,
  then reconnects to *that*. So Redpanda has two listeners:
  - `internal://redpanda:9092` for containers
  - `external://localhost:19092` for the host

  With only one, either your host scripts or your containers connect and then hang.
- **Mongo replica set from your host.** The replica-set member is named `mongo:27017`, which your
  host can't resolve. Use `?directConnection=true` from the host to skip topology discovery.
  Containers use `mongodb://mongo:27017/?replicaSet=rs0`.

## 4. Health checks and startup ordering

| `depends_on` form                                   | Waits for              |
| --------------------------------------------------- | ---------------------- |
| `depends_on: [postgres]`                            | the process *started*  |
| `depends_on: { postgres: { condition: service_healthy } }` | healthcheck *passing* |

Probes chosen, and the trap each one avoids:

- **Postgres:** `pg_isready -h 127.0.0.1`. On first boot the entrypoint runs a temporary server
  on the unix socket only (to run init scripts), then restarts. Plain `pg_isready` (socket) reports
  ready during that window. Forcing TCP only passes against the final server.
- **Mongo:** initiates the replica set if needed, and is healthy only once this node
  `isWritablePrimary`. "Process up" ≠ "elected primary".
- **Redis:** `redis-cli ping | grep PONG`. While loading data from disk, Redis replies
  `-LOADING`, and `redis-cli` can still exit 0.
- **Redpanda:** `rpk cluster health` → `Healthy: true`.
- **Services:** `/ready`, not `/health`. Compose uses the check to gate *dependents*, so it should
  mean "can serve traffic".

**Healthchecks don't replace retries.** In production there is no `depends_on`, and Postgres can
restart at any time. So the service also does `connectWithRetry` (exponential backoff with **full
jitter**, so 9 services don't reconnect in lockstep). The `pg` pool also has an `error` listener:
without one, an idle connection dropped by a Postgres restart emits an unhandled `'error'` event,
which crashes the process.

**Liveness vs readiness** (`packages/service-kit/src/server.ts`):

- `/health` (liveness) never touches dependencies.
- `/ready` (readiness) checks them, each with a timeout, and returns 503 once shutdown starts.

If liveness checked the DB, a single DB blip would fail liveness for every replica of every
service at once. The orchestrator would then restart all of them simultaneously.

## 5. Env validation (`packages/config`)

- Parse once at boot with Zod. On failure, print **every** issue and `exit(1)`. Returns a frozen,
  typed object, and nothing else reads `process.env`.
- `z.coerce.number()` fixes `"480000" + now` string concatenation bugs.
- **`z.coerce.boolean()` is a trap**: `Boolean("false") === true`. Use `envBoolean()`.
- Empty strings are treated as unset. Otherwise `PORT=` coerces to `0`.

## 6. Graceful shutdown (`packages/service-kit/src/lifecycle.ts`)

```
SIGTERM → /ready flips to 503 (stop sending me traffic)
        → hooks run LIFO: http server closes (drains in-flight) → [kafka consumer] → pg pool
        → exit(0)
        → safety timer forces exit(1) at SHUTDOWN_TIMEOUT_MS (8s) < Docker's 10s SIGKILL
```

- **PID 1:** the kernel applies no default signal action to PID 1, so Node without a SIGTERM
  handler ignores it. Docker then waits 10 s and SIGKILLs. Fixes in place:
  - an explicit handler
  - `CMD ["node", ...]` (not `pnpm start`, which may not forward signals)
  - `init: true` (tini)
- A second Ctrl+C forces exit. An `uncaughtException` or `unhandledRejection` triggers a bounded
  shutdown with exit 1.
- **Kafka angle (Phase 2):** a consumer killed after processing but before committing its offset
  gets that message redelivered to another consumer, which is a duplicate. Without a clean
  leave-group, the broker waits for the session timeout before rebalancing, so those partitions
  stall.

## 7. CI (`.github/workflows/ci.yml`)

- `verify` job: frozen install → prettier check → `turbo run build lint typecheck test` → compose
  config validation.
- `docker` job: builds each service image (BuildKit cache in GitHub Actions).
- ESLint uses `strictTypeChecked`. The rule that matters most for backends is
  `no-floating-promises`: an un-awaited promise is a future unhandled rejection.

## Verified during scaffolding

- `docker compose config`: valid.
- Docker build stages simulated without Docker: `turbo prune` → frozen install → build →
  `pnpm deploy --prod`, then the output booted.
- Against a real Postgres (embedded, outside Docker):
  - The service was started *before* Postgres. It retried 5× with jitter (130, 343, 709, 626,
    1398 ms), connected, and served.
  - Stopping Postgres: `/ready` → 503 `connect ECONNREFUSED`, `/health` stayed 200.
  - The pool logged `terminating connection due to administrator command` and didn't crash.
  - Restarting Postgres: `/ready` → 200, and queries worked again with no service restart.
  - SIGTERM: http closed → postgres closed → exit 0 in ~12 ms.
- Bad config: all 3 errors listed at once, exit 1.

---

## Break it

**A. Startup race**

1. In `docker-compose.yml`, under `template-service`, change the `depends_on` entry to just
   `- postgres` and set `DB_CONNECT_MAX_ATTEMPTS: 1`.
2. `docker compose --profile apps down -v` (an empty volume forces `initdb`, the slow path).
3. `docker compose --profile apps up --build` (no `-d`; watch the interleaved logs).
4. Expect: `template-service` starts within a second, logs `ECONNREFUSED`, exits 1. Postgres is
   still running init. Note the timestamps.
5. Restore one fix at a time, re-run step 2–3 each time:
   - healthcheck condition only
   - retry only
   - both

   Observe what each one alone covers.

**B. Postgres restarts while the service runs** (with both fixes restored)

```bash
docker compose --profile apps up -d --wait
curl localhost:3000/v1/db-time
docker compose restart postgres
curl -i localhost:3000/ready      # 503 for a moment, then 200
curl localhost:3000/v1/db-time    # works again, no service restart
```

Then comment out the `pool.on('error', …)` listener in `apps/template-service/src/db/postgres.ts`,
rebuild, and repeat. Watch what happens to the process.

**C. Shutdown**

```bash
docker compose --profile apps stop template-service   # should take well under 10s
docker compose --profile apps logs template-service | tail
```

Then remove `lifecycle.installSignalHandlers()` from `src/index.ts` **and** `init: true` from
compose, rebuild, and time `docker compose stop` again. Expect ~10 s and exit code 137
(128 + 9 = SIGKILL): Node as PID 1 ignored SIGTERM.

Write what you saw (timings, log lines) in the section below.

### What broke

_(fill in)_

---

## Mastery questions

### Image vs container vs volume?

_(your answer)_

### Why is `depends_on` not enough without a health check?

_(your answer)_

### What is graceful shutdown, and why does it matter for Kafka consumers?

_(your answer)_
