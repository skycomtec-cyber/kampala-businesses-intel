#!/bin/sh
# Kampala Businesses Intel - container entrypoint.
#
# Why this exists: on a PaaS (Render, Railway) the persistent disk that holds the
# database is bind-mounted root-owned, while the image runs as the unprivileged
# `node` user. better-sqlite3 then cannot create the SQLite file and the process
# dies on its first query with SQLITE_CANTOPEN, which reads as a database bug
# rather than the permissions one it actually is.
#
# So the container starts as root, this script makes the data directory writable
# by `node`, and then drops privileges before the app is exec'd. `docker compose`
# sets `user: node` itself, so there the drop is skipped and this script is a
# no-op: the named volume inherits the image's `node`-owned /data on first use.
#
# The chown is best effort on purpose. It fails legitimately on a read-only or
# no-chown filesystem, and the app reports its own write failure clearly, so a
# start is not aborted over it.
set -eu

DATA_DIR="${KIP_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || \
    echo "docker-entrypoint: could not chown $DATA_DIR; continuing" >&2
  # setpriv is util-linux, which ships in the Debian base image. exec keeps node
  # as the process container signals reach (tini is PID 1 above it).
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
