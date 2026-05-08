#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f bench/postgres-compose.yml up -d
echo "waiting for postgres to be healthy..."
until docker inspect -f '{{.State.Health.Status}}' fearless-bench-pg 2>/dev/null | grep -q healthy; do
  sleep 0.5
done

count=$(docker exec fearless-bench-pg psql -U fearless -d fearless_bench -tAc "SELECT count(*) FROM world")
if [[ "$count" != "10000" ]]; then
  echo "ERROR: expected 10000 world rows, got $count" >&2
  exit 1
fi

echo "ready: postgres://fearless:fearless@localhost:5433/fearless_bench (world: $count rows)"
