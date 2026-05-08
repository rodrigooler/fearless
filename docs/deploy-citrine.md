# Deploying Fearless on bare-metal Linux for TFB-class numbers

This guide takes you from a fresh bare-metal Linux box to a Fearless server hitting the kind of throughput TFB Citrine reports — where the framework actually shines vs the OrbStack VM dev numbers.

**Why bare-metal:** OrbStack VM hides 3-5× of available throughput because (a) virtio-net IRQs land on a single vCPU, (b) hypervisor scheduling dilutes io_uring SQPOLL, (c) ARM-on-Mac translates x86 instructions for some Docker images. Bare-metal Linux on x86_64 with a multi-queue NIC removes all three ceilings.

**Recommended hosts** (price/perf for benchmark traffic, not production):
- **Hetzner AX102** — AMD Ryzen 9 7950X3D (16C/32T), 128 GB RAM, 10 GbE NIC, ~€135/month. Best price/throughput in 2026.
- **Latitude.sh m4.large** — Intel Xeon Silver 4316 (20C), 128 GB RAM, 25 GbE, ~$340/month.
- **Equinix Metal m3.small.x86** — Intel Xeon E-2378G (8C/16T), 64 GB RAM, 2×10 GbE, ~$300/month.

Don't use AWS m7i.metal for first runs — egress and VPC overhead will dominate.

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

Generate AOT handlers from the bench app:

```bash
# Optional: install Node + Bun if you want to regenerate handlers locally.
# For TFB submission, the generated `aot_handlers.rs` is committed to the repo
# so cargo build is enough.
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Regenerate (idempotent if no app changes)
node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo
```

Build the production image (with `aot-handlers` feature ON):

```bash
docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless:tfb .
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
  -e DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/hello_world \
  -e FEARLESS_WORKERS=$(nproc) \
  fearless:tfb

# Verify
curl -i http://localhost:8080/plaintext
curl -i http://localhost:8080/json
curl -i http://localhost:8080/db
```

If `/db` 503s, the Postgres typed handle isn't yet wired (Phase C work — see roadmap). For now, that endpoint serves via the Bun fallback runtime.

## 6. Bench

Local sanity:

```bash
wrk -t 16 -c 256 -d 15 http://localhost:8080/plaintext
```

Real TFB-equivalent run from a separate machine on the same LAN (ideally with a 10 GbE NIC):

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
docker stop fearless-aot fearless-pg
docker rm fearless-aot fearless-pg
```
