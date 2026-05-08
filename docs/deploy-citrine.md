# Deploying Fearless on bare-metal Linux for TFB-class numbers

This guide takes you from a fresh bare-metal Linux box to a Fearless server hitting the kind of throughput TFB Citrine reports — where the framework actually shines vs the OrbStack VM dev numbers.

> **Quick path (Phase 1.2+):** if you just want results, skip to [§ 0 One-shot deploy](#0-one-shot-deploy-phase-12) — `scripts/deploy-baremetal.sh` does sections 1, 3, 5, 6 and the new comparison-app run for you.

**Why bare-metal:** OrbStack VM hides 3-5× of available throughput because (a) virtio-net IRQs land on a single vCPU, (b) hypervisor scheduling dilutes io_uring SQPOLL, (c) ARM-on-Mac translates x86 instructions for some Docker images. Bare-metal Linux on x86_64 with a multi-queue NIC removes all three ceilings.

**Recommended hosts** (price/perf for benchmark traffic, not production):
- **Hetzner AX102** — AMD Ryzen 9 7950X (16C/32T), 64–128 GB RAM, 1 GbE NIC (10 GbE on AX-Line), ~€135/month. Best price/throughput in 2026 and the host this guide is calibrated for.
- **Latitude.sh m4.large** — Intel Xeon Silver 4316 (20C), 128 GB RAM, 25 GbE, ~$340/month.
- **Equinix Metal m3.small.x86** — Intel Xeon E-2378G (8C/16T), 64 GB RAM, 2×10 GbE, ~$300/month.

Don't use AWS m7i.metal for first runs — egress and VPC overhead will dominate.

> **Note on this doc's location:** `docs/superpowers/` is gitignored as internal team material. This file (`docs/deploy-citrine.md`) is not — it ships with the repo so anyone reproducing the bench has it.

## 0. One-shot deploy (Phase 1.2+)

Once the host is provisioned and you have ssh access:

```bash
# from your laptop (repo root)
./scripts/deploy-baremetal.sh ax102.example.com --ssh-user root
# or, to rehearse without touching the remote:
./scripts/deploy-baremetal.sh ax102.example.com --ssh-user root --dry-run
```

The script:

1. ssh smoke-tests the target.
2. rsyncs the repo to `/opt/fearless` (excluding `target/`, `node_modules/`, `.git/`, `docs/superpowers/`).
3. installs Docker, Node 20+, Bun 1.1+, Rust stable, wrk.
4. generates AOT handlers (`scripts/fearless-build.mjs`) and builds the rust-core image (`fearless-rust-aot:dev`) plus all four comparison apps (`bench/comparison/{ntex-rust,bun-serve,elysia-bun,hono-bun}`).
5. starts two Postgres instances: the bench compose at `:5433` (used by `run-bench.mjs`) and a host-network Postgres at `:5432` (for the comparison apps).
6. runs `node scripts/run-bench.mjs --quick --note "bare-metal AX102 first-run"`.
7. starts each comparison app one at a time and runs `wrk -t8 -c64 -d10s` against `/plaintext`, `/json`, `/db`.
8. writes `bench-baremetal-report-YYYY-MM-DD.md` locally with the merged results.

The script is idempotent: rerun to refresh code, rebuild, re-bench. The remote `/opt/fearless` is treated as a working tree, not a git checkout.

If you'd rather walk through manually (recommended for the first run on a new host), continue with section 1.

## 1. Provision and prep

After SSH'ing in (assume Debian 12 / Ubuntu 22.04 LTS, kernel ≥ 6.0):

```bash
# Verify kernel
uname -r              # need >= 6.0 for AcceptMulti, RecvMulti, SQPOLL
free -g
nproc
ip -br link           # confirm NIC name (eth0, ens4, enp0s3, etc.)

# Update + base tools
apt-get update -y
apt-get install -y docker.io docker-compose-plugin curl wrk netperf
systemctl enable --now docker

# Disable irqbalance (we'll set affinity manually)
systemctl disable --now irqbalance

# Optional but recommended for benchmarking
apt-get install -y htop iotop sysstat linux-tools-common linux-tools-generic
```

## 2. Apply host-side tuning

Copy the sysctl + IRQ + RPS settings from [`docs/deployment-tuning.md`](./deployment-tuning.md). The TL;DR copy-paste from that doc is enough to unlock 2-5× throughput. Re-read it; the IRQ affinity step is the single biggest win.

After applying, verify:

```bash
sysctl net.core.somaxconn       # 65535
cat /proc/interrupts | grep eth # expect non-zero across multiple CPUs
cat /sys/class/net/eth0/queues/rx-0/rps_cpus  # non-zero mask
```

## 3. Build and run Fearless

Clone the repo:

```bash
git clone https://github.com/rodrigooler/fearless.git
cd fearless
```

### 3.1 Generate AOT handlers (Phase 1.2+ requires this)

```bash
# Install Node 20+ and Bun 1.1+
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Regenerate handlers from the bench app — needed before docker build.
# (--no-cargo skips the cargo step because the docker build does it.)
node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo
```

If you skip this and the image has stale handlers, the rust-core binary will compile but routes won't match the latest `examples/real-bench/server.ts`.

### 3.2 Build the rust-core image

```bash
# Use the SHARED tag — `fearless-rust-aot:dev`. The bench harness and any
# manual smoke runs reuse this image, so we don't accumulate variants.
docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust-aot:dev .
docker builder prune -f   # reclaim build cache (disk-discipline rule)
```

## 4. Postgres for /db, /queries, /fortunes, /updates

```bash
docker run -d --name fearless-pg \
  -e POSTGRES_PASSWORD=pw \
  -e POSTGRES_DB=hello_world \
  -p 5432:5432 \
  --shm-size=1g \
  postgres:16 \
  -c shared_buffers=1GB \
  -c max_connections=2000 \
  -c work_mem=16MB

sleep 5
docker exec -i fearless-pg psql -U postgres -d hello_world < bench/techempower/seed.sql
```

(`bench/techempower/seed.sql` mirrors the TFB World + Fortune table layout — see [TechEmpower's Postgres setup](https://github.com/TechEmpower/FrameworkBenchmarks/tree/master/toolset/databases/postgres) for the canonical schema.)

## 5. Run the server

```bash
docker run -d --name fearless-aot \
  --network host \
  --ulimit memlock=-1 \
  --ulimit nofile=1048576:1048576 \
  --cap-add SYS_NICE \
  --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined \
  -e FEARLESS_SQL_PRIMARY=postgres://postgres:pw@127.0.0.1:5432/hello_world \
  -e FEARLESS_SQL_PRIMARY_POOL_SIZE=64 \
  -e FEARLESS_WORKERS=$(nproc) \
  fearless-rust-aot:dev

# Verify
curl -i http://localhost:8080/plaintext
curl -i http://localhost:8080/json
curl -i http://localhost:8080/db
```

`FEARLESS_SQL_PRIMARY` (Phase 1.2+) replaces the older `DATABASE_URL` env. The pool size defaults to `64` and is sized per worker — leave it unless `pg_stat_activity` shows you're saturating.

If `/db` 503s on a Phase 1.2 build, the AOT handlers were not regenerated against the current `examples/real-bench/server.ts`. Re-run `node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo` and rebuild the image.

## 6. Bench

### 6.1 Local sanity

```bash
wrk -t 16 -c 256 -d 15 http://localhost:8080/plaintext
```

### 6.2 Full harness (Phase 1.2)

```bash
# Brings up Postgres + rust-core + Bun + wrk-runner, runs every scenario,
# appends to bench-history.json. Linux auto-detects host networking; macOS
# uses bridge + host.docker.internal. Override with FEARLESS_BENCH_HOST_MODE.
node scripts/run-bench.mjs --quick --note "bare-metal AX102 first-run"
```

The harness is platform-portable: on Linux it picks `--network host` and `127.0.0.1` for container-to-host reach; on macOS it falls back to `-p` + `host.docker.internal`. No flags needed.

### 6.3 Comparison frameworks

Four head-to-head apps live in `bench/comparison/`:

| Dir          | Stack                           | Build/run                                  |
|--------------|---------------------------------|--------------------------------------------|
| `ntex-rust`  | Rust + ntex 2 + tokio-postgres  | `cargo build --release` then `./target/release/ntex-bench` |
| `bun-serve`  | Native Bun.serve + `postgres`   | `bun install && bun run server.ts`         |
| `elysia-bun` | Elysia 1.x on Bun               | `bun install && bun run server.ts`         |
| `hono-bun`   | Hono 4.x on Bun                 | `bun install && bun run server.ts`         |

Each app honours `BENCH_PORT` and `DATABASE_URL`. Run wrk against each with the same plan as the fearless harness and compare. `scripts/deploy-baremetal.sh` automates the loop.

### 6.4 Real TFB-equivalent run

From a separate machine on the same LAN (ideally with a 10 GbE NIC):

```bash
# Install pipeline.lua first — see scripts/run-bench.mjs for the file
wrk -t 16 -c 256 -d 30 -s pipeline.lua http://<server-ip>:8080/plaintext -- 16
```

Numbers to expect on AX102 with proper tuning (extrapolated from OrbStack data × 5x for hardware uplift):

| Endpoint | Pipelined (TFB-style) | Non-pipelined c=256 |
|---|---|---|
| `/plaintext` | 25-40M req/s | 1.5-2.5M req/s |
| `/json` | 24-38M req/s | 1.4-2.4M req/s |
| `/echo/:name` | 18-30M req/s | 1.3-2.0M req/s |
| `/db` (Postgres single, via Bun fallback) | n/a | 80-150k req/s |
| `/db` (Postgres single, post-Phase-C typed handle) | n/a | 500k-1M req/s |
| `/queries?queries=20` | n/a | 8-15k req/s |

These are projections, not measurements. Real run goes in `bench-history.json` so you can compare what we predicted vs reality.

## 7. Submit to TechEmpower

See [`tfb-submission.md`](./tfb-submission.md) for the PR checklist.

## Troubleshooting

- **`io_uring_setup` fails**: kernel < 5.19, or seccomp blocking. Check `dmesg | tail`. Add `--security-opt seccomp=unconfined`.
- **Worker count = 1 in logs**: `FEARLESS_WORKERS` not picked up. Check env was passed and parses as int.
- **All requests on CPU 0**: IRQ affinity didn't apply. Re-run the affinity loop from `deployment-tuning.md`. Verify with `cat /proc/interrupts | grep eth` after a load test.
- **Postgres connection refused**: `--network host` not used. The container can reach `127.0.0.1:5432` only if it shares the host network namespace.
- **wrk reports many "Non-2xx" responses**: usually Bun fallback returning 401 (auth-protected route hit without header) or 503 (DB down). Check `docker logs fearless-aot`.

## Cleanup

```bash
# Manual single-server cleanup (section 5)
docker rm -f fearless-aot fearless-pg

# Bench-harness containers (run-bench.mjs)
docker rm -f pg-bench fearless-aot wrk-runner

# Comparison setup (deploy-baremetal.sh)
docker rm -f fearless-bench-pg fearless-cmp-pg
docker builder prune -f
```
