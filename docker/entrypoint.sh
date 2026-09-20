#!/bin/sh
set -eu

case "${MEET_APP:-}" in
  api)
    exec node apps/api/dist/server.js
    ;;
  worker)
    exec node apps/worker/dist/main.js
    ;;
  *)
    echo "MEET_APP must be api or worker, got: ${MEET_APP:-}" >&2
    exit 1
    ;;
esac
