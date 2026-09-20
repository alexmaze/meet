# syntax=docker/dockerfile:1

ARG APP=api

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/database/package.json packages/database/
COPY packages/media/package.json packages/media/
COPY packages/memory/package.json packages/memory/
COPY packages/jobs/package.json packages/jobs/
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG APP=api
COPY . .
RUN pnpm run build:packages \
  && if [ "$APP" = "api" ]; then \
       pnpm --filter @meet/api build; \
     elif [ "$APP" = "worker" ]; then \
       pnpm --filter @meet/worker build; \
     else \
       echo "APP must be api or worker, got: $APP" >&2; exit 1; \
     fi

FROM base AS runtime
ARG APP=api
ENV NODE_ENV=production \
  MEDIA_LOCAL_DIR=/data/media \
  EMBEDDING_LOCAL_CACHE_DIR=/data/embedding-models \
  MEET_APP=${APP}
RUN mkdir -p /data/media /data/embedding-models \
  && chown -R node:node /data

# 保留 monorepo 目录与 pnpm symlink，避免 ../../../ 路径解析失败
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh \
  && rm -rf \
    apps/web/src \
    apps/api/src \
    apps/worker/src \
    apps/*/test \
    packages/*/src

USER node
WORKDIR /app

EXPOSE 8787
CMD ["/app/docker/entrypoint.sh"]
