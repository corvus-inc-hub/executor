# Self-hosted Executor data plane. WorkOS AuthKit supplies identity.
# Build context is the repo root because Bun workspaces need every member:
#   docker build -f apps/host-selfhost/Dockerfile -t executor-selfhost .
#
# Runtime needs this container, WorkOS AuthKit configuration, and a data volume.

FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @executor-js/host-selfhost \
  && bun run apps/host-selfhost/scripts/package-runtime.ts

FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/host-selfhost && bun run build

FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
ARG EXECUTOR_IMAGE_SOURCE
ARG EXECUTOR_SOURCE_REVISION
ARG EXECUTOR_UPSTREAM_REVISION=724600c1a26594f23388e6cac067f86a62cc3764
LABEL org.opencontainers.image.source="${EXECUTOR_IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${EXECUTOR_SOURCE_REVISION}" \
      org.opencontainers.image.description="Single-container self-hosted Executor" \
      org.opencontainers.image.licenses="MIT" \
      io.mnfst.executor.auth-provider="workos-authkit" \
      io.mnfst.executor.upstream-revision="${EXECUTOR_UPSTREAM_REVISION}"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=prod-deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=prod-deps /app/.selfhost-runtime /app
COPY --from=build /app/apps/host-selfhost/dist /app/apps/host-selfhost/dist
WORKDIR /app/apps/host-selfhost
VOLUME ["/data"]
EXPOSE 4788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "run", "dist-server/serve.js"]
