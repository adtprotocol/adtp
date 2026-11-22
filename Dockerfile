# syntax=docker/dockerfile:1

# One exact Node release, by version and by digest, for both stages. Node 22 is
# the line this code is tested on (package.json "engines" says the same); move
# to a newer release deliberately, by changing this line and running the tests.
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# ---- build: compile TypeScript ------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json SPEC.md ./
COPY src ./src
COPY test ./test
COPY demo ./demo
COPY examples ./examples
COPY integrations ./integrations
COPY migrations ./migrations
RUN npm run build

# ---- runtime: production dependencies + compiled output ---------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/demo ./dist/demo
COPY --from=build /app/dist/examples ./dist/examples
COPY --from=build /app/dist/integrations ./dist/integrations
COPY migrations ./migrations
# The config the node starts with when nothing else is mounted here: every
# value comes from the environment (see the file). Compose mounts its own.
COPY deploy/env.config.yaml ./adtp.config.yaml

# `adtp` on the PATH, so `docker compose exec node adtp <command>` works.
RUN chmod +x dist/src/cli.js && ln -s /app/dist/src/cli.js /usr/local/bin/adtp

# Keys, the two API tokens and the SQLite database live in /data. Mount a volume there.
RUN mkdir -p /data && chown node:node /data
# The node runs as an unprivileged user. Some platforms hand a container a
# volume that only root can write to; there, build with RUN_AS=root (fly.toml does).
ARG RUN_AS=node
USER ${RUN_AS}
VOLUME /data
ENV ADTP_CONFIG=/app/adtp.config.yaml \
    ADTP_DATA_DIR=/data

EXPOSE 7387
# The health check assumes listen.port 7387; change the published port in Compose, not the listen port.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:7387/healthz || exit 1

CMD ["node", "dist/src/cli.js", "start"]
