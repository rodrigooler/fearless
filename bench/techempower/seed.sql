-- TFB-canonical Postgres schema for the World + Fortune tables.
-- Mirrors what the TechEmpower toolset expects so /db, /queries, /fortunes,
-- /updates all conform to the spec.
--
-- Apply with:
--   docker exec -i fearless-pg psql -U postgres -d hello_world < seed.sql

DROP TABLE IF EXISTS world;
DROP TABLE IF EXISTS fortune;

CREATE TABLE world (
    id           INTEGER NOT NULL PRIMARY KEY,
    randomnumber INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE fortune (
    id      INTEGER NOT NULL PRIMARY KEY,
    message VARCHAR(2048) NOT NULL
);

-- Seed World: 10,000 rows with random numbers 1..10000 (TFB spec).
INSERT INTO world (id, randomnumber)
SELECT g, 1 + (random() * 9999)::int
FROM generate_series(1, 10000) g;

-- Seed Fortune: TFB's canonical 12-row dataset.
INSERT INTO fortune (id, message) VALUES
  (1,  'fortune: No fortunes found.'),
  (2,  'A computer scientist is someone who fixes things that aren''t broken.'),
  (3,  'After enough decimal places, nobody gives a damn.'),
  (4,  'A bad random number generator: 1, 1, 1, 1, 1, 4.33e+67, 1, 1, 1'),
  (5,  'A computer program does what you tell it to do, not what you want it to do.'),
  (6,  'Emacs is a nice operating system, but I prefer UNIX. — Tom Christaensen'),
  (7,  'Any program that runs right is obsolete.'),
  (8,  'A list is only as strong as its weakest link. — Donald Knuth'),
  (9,  'Feature: A bug with seniority.'),
  (10, 'Computers make very fast, very accurate mistakes.'),
  (11, '<script>alert("This should not be displayed in a browser alert box.");</script>'),
  (12, 'フレームワークのベンチマーク');

VACUUM ANALYZE world;
VACUUM ANALYZE fortune;

SELECT 'world' AS table_name, count(*) AS rows FROM world
UNION ALL
SELECT 'fortune', count(*) FROM fortune;
