# syntax=docker/dockerfile:1.7
#
# One Dockerfile for every Node service:
#   docker build -f docker/node-service.Dockerfile --build-arg SERVICE=template-service .
#
# Stages:
#   pruner  → turbo prune: a minimal copy of the monorepo with only this service + its workspace deps
#   builder → install (cached) + compile TS + `pnpm deploy` a self-contained prod folder
#   runtime → node:alpine + that folder. No pnpm, no TS, no dev deps, no source.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS pruner
ARG SERVICE
COPY . .
# out/json = package.json files + lockfile only (for the cached install layer)
# out/full = the source of the pruned workspace
RUN pnpm dlx turbo@2.11.6 prune @seatrush/${SERVICE} --docker

# ---------------------------------------------------------------------------
FROM base AS builder
ARG SERVICE
# Layer-cache trick: copy ONLY manifests + lockfile, then install. This layer
# is reused until a dependency changes, so a code-only change skips the install.
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now the source. Any code change invalidates from here down, not above.
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@seatrush/${SERVICE}

# Copy the service + its built workspace deps + PROD node_modules into /prod.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@seatrush/${SERVICE} deploy --prod --legacy /prod

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod .
# Never run as root in the container.
USER node
EXPOSE 3000
# exec form: node is the process that receives SIGTERM.
# NOT `pnpm start` / `npm start`: the package manager becomes PID 1 and may not forward signals.
CMD ["node", "dist/index.js"]
