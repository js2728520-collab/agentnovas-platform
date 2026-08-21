ARG NODE_IMAGE=node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM base AS builder
ARG RIVERTON_APP_AUDIENCE
ARG RIVERTON_RELEASE_TAG
ARG GIT_COMMIT_SHA
ENV RIVERTON_APP_AUDIENCE=${RIVERTON_APP_AUDIENCE} \
    RIVERTON_RELEASE_TAG=${RIVERTON_RELEASE_TAG} \
    GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN case "${RIVERTON_APP_AUDIENCE}" in \
      client|operations|maintenance) npm run "build:${RIVERTON_APP_AUDIENCE}" ;; \
      *) echo "Unsupported RIVERTON_APP_AUDIENCE" >&2; exit 64 ;; \
    esac

FROM base AS web
ARG RIVERTON_APP_AUDIENCE
ARG RIVERTON_APP_HOST
ARG RIVERTON_RELEASE_TAG
ARG GIT_COMMIT_SHA
LABEL org.opencontainers.image.title="AgentNovas Riverton ${RIVERTON_APP_AUDIENCE}" \
      org.opencontainers.image.version="${RIVERTON_RELEASE_TAG}" \
      org.opencontainers.image.revision="${GIT_COMMIT_SHA}" \
      org.opencontainers.image.source="https://github.com/js2728520-collab/agentnovas-platform"
ENV RIVERTON_APP_AUDIENCE=${RIVERTON_APP_AUDIENCE} \
    RIVERTON_APP_HOST=${RIVERTON_APP_HOST} \
    RIVERTON_RELEASE_TAG=${RIVERTON_RELEASE_TAG} \
    GIT_COMMIT_SHA=${GIT_COMMIT_SHA} \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next-${RIVERTON_APP_AUDIENCE}/standalone ./
COPY --from=builder --chown=node:node /app/.next-${RIVERTON_APP_AUDIENCE}/static ./.next-${RIVERTON_APP_AUDIENCE}/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "const http=require('node:http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health/live',headers:{host:process.env.RIVERTON_APP_HOST}},res=>process.exit(res.statusCode===200?0:1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));"]
CMD ["node", "server.js"]

FROM base AS runtime
ARG RIVERTON_RELEASE_TAG
ARG GIT_COMMIT_SHA
LABEL org.opencontainers.image.title="AgentNovas Riverton runtime" \
      org.opencontainers.image.version="${RIVERTON_RELEASE_TAG}" \
      org.opencontainers.image.revision="${GIT_COMMIT_SHA}" \
      org.opencontainers.image.source="https://github.com/js2728520-collab/agentnovas-platform"
ENV RIVERTON_RELEASE_TAG=${RIVERTON_RELEASE_TAG} \
    GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node db ./db
COPY --chown=node:node lib ./lib
COPY --chown=node:node packages ./packages
COPY --chown=node:node postgres ./postgres
COPY --chown=node:node scripts ./scripts
USER node
CMD ["node", "--experimental-strip-types", "scripts/notification-worker.mjs"]
