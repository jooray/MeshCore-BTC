#!/usr/bin/env bash
# Supervises index.mjs and restarts it whenever it exits, whether from a
# crash or from the in-process watchdog (exit code 42, see index.mjs).
set -uo pipefail
cd "$(dirname "$0")"

while true; do
  echo "[$(date -Iseconds)] Starting bitcoinBot..."
  node index.mjs "$@"
  exit_code=$?
  echo "[$(date -Iseconds)] bitcoinBot exited with code $exit_code. Restarting in 10s..."
  sleep 10
done
