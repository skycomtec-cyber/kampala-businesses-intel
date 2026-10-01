# syntax=docker/dockerfile:1

# The app is Node with a native SQLite dependency, so the image needs a build
# toolchain for better-sqlite3 and nothing else. No Python service, no database
# server, no message queue: SQLite is a file and the engine is a scheduled Node
# process, which is why this image installs one thing and runs one thing.
#
# Build from the `app` folder so the image contains the app and not the launcher:
#   docker build -t kampala-intel ./app

# ---------------------------------------------------------------------------
# Stage 1: install dependencies, including the native build of better-sqlite3.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# build-essential for node-gyp, python3 for its own interpreter. Kept in a
# build stage so none of it is in the shipped image.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/kampala

# The lockfile is copied on its own so `npm ci` is cached independently of the
# source. Editing a route does not reinstall node_modules.
COPY package.json package-lock.json ./

# `npm ci` rather than `npm install`: it installs exactly the lockfile and fails
# if package.json and the lockfile disagree, which is what should happen when a
# dependency is added without committing the lockfile.
#
# The rebuild is not redundant. better-sqlite3 ships prebuilt binaries keyed by
# Node ABI and platform, and falls back to compiling from source when one is
# missing. If it downloaded a binary built for a different libc than this image
# has, the install succeeds and the process then dies on its first query with an
# unhelpful loader error. Rebuilding against the image's own toolchain makes the
# binary match the image, and it is the step that actually needs the
# build-essential installed above.
RUN npm ci --omit=dev \
  && npm rebuild better-sqlite3 \
  && node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('better-sqlite3 loads')"


# ---------------------------------------------------------------------------
# Stage 2: the runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# curl for the healthcheck below. libstdc++6 is the one runtime library
# better-sqlite3 links against; without it the process starts and then dies on
# the first query with an unhelpful loader error.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends curl libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

# tini reaps the zombies a scheduled child process would otherwise leave, and
# forwards SIGTERM to node. Without an init, `docker stop` waits the full 10s
# grace period and then SIGKILLs, which skips the clean SQLite close in
# src/server.js.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/kampala

COPY --from=deps /srv/kampala/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web

# The one directory that survives `docker rm`. Everything else above is
# reproducible from this file and the git repository, so an image rebuild is not a
# reason to lose a database.
RUN mkdir -p /data && chown -R node:node /data /srv/kampala
VOLUME ["/data"]

ENV NODE_ENV=production \
    KIP_DATA_DIR=/data \
    KIP_HOST=0.0.0.0 \
    KIP_PORT=4310

# Running as the unprivileged `node` user that the base image already provides.
# The data directory is chowned above so this does not need root to write.
USER node

EXPOSE 4310

# Reports on the app actually answering, not on the process existing. /api/v1/meta
# is the endpoint that returns the configuration in force, which makes it the one
# that fails when the database is unreachable - exactly what a healthcheck should
# catch, and a TCP port probe would not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${KIP_PORT}/api/v1/meta" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]