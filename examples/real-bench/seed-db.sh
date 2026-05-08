#!/usr/bin/env bash
# Seeds the `world` table for the bench. Mirrors TFB's data layout so numbers
# are comparable across frameworks.
#
# Pre-requisite: a Postgres instance running and reachable at $DATABASE_URL
# (default: postgres://postgres:pw@127.0.0.1:5432/postgres).

set -euo pipefail

DB_URL="${DATABASE_URL:-postgres://postgres:pw@127.0.0.1:5432/postgres}"

echo "Seeding world table at ${DB_URL} ..."

docker run --rm --network host -e PGPASSWORD=pw postgres:16 psql "${DB_URL}" <<'SQL'
DROP TABLE IF EXISTS world;
CREATE TABLE world (
  id           INTEGER PRIMARY KEY,
  randomnumber INTEGER NOT NULL
);

INSERT INTO world (id, randomnumber)
SELECT g, (random() * 10000)::int
FROM generate_series(1, 10000) g;

VACUUM ANALYZE world;

SELECT count(*) AS world_rows FROM world;
SQL

echo "✓ Seeded 10,000 rows."
