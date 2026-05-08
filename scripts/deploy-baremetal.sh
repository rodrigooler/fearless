#!/usr/bin/env bash
# deploy-baremetal.sh — provision and bench Fearless on a fresh bare-metal
# Linux host (target: Hetzner AX102 / Ubuntu 24.04). Idempotent: rerun to
# refresh code, rebuild, re-bench.
#
# Usage:
#   scripts/deploy-baremetal.sh <host> [--ssh-user <user>] [--dry-run]
#
# Steps:
#   1. ssh smoke-test the target host
#   2. rsync repo → /opt/fearless (excluding target/, node_modules/, .git/)
#   3. install deps (docker, rust, bun, node, wrk)
#   4. build rust-core docker image + each comparison app
#   5. start postgres via scripts/start-bench-postgres.sh
#   6. run scripts/run-bench.mjs --quick
#   7. run wrk against each comparison app
#   8. write bench-baremetal-report-YYYY-MM-DD.md

set -euo pipefail

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
HOST=""
SSH_USER="root"
DRY_RUN=0

usage() {
  cat <<EOF
usage: $0 <host> [--ssh-user <user>] [--dry-run]

  <host>            Hostname or IP of the bare-metal target.
  --ssh-user USER   SSH username (default: root).
  --dry-run         Print the plan, don't execute remote steps.

EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage ;;
    -*)         echo "unknown flag: $1" >&2; usage ;;
    *)          if [[ -z "$HOST" ]]; then HOST="$1"; shift; else echo "extra arg: $1" >&2; usage; fi ;;
  esac
done

[[ -z "$HOST" ]] && usage

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_ROOT="/opt/fearless"
DATE_TAG="$(date +%Y-%m-%d)"
REPORT_FILE="bench-baremetal-report-${DATE_TAG}.md"
SSH_TARGET="${SSH_USER}@${HOST}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy] WARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[deploy] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

run_remote() {
  if (( DRY_RUN )); then
    printf '  [dry-run] ssh %s -- %s\n' "$SSH_TARGET" "$*"
  else
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"
  fi
}

run_remote_script() {
  # heredoc → remote bash; logs the script in dry-run.
  local script="$1"
  if (( DRY_RUN )); then
    printf '  [dry-run] ssh %s -- bash <<SCRIPT\n%sSCRIPT\n' "$SSH_TARGET" "$script"
  else
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "bash -s" <<<"$script"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: SSH smoke
# ---------------------------------------------------------------------------
log "1/8 ssh smoke-test ${SSH_TARGET}"
if (( DRY_RUN )); then
  printf '  [dry-run] ssh %s "uname -a && nproc && free -g"\n' "$SSH_TARGET"
else
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "uname -a && nproc && free -g" \
    || die "ssh to ${SSH_TARGET} failed; abort"
fi

# ---------------------------------------------------------------------------
# Step 2: rsync code
# ---------------------------------------------------------------------------
log "2/8 rsync repo → ${SSH_TARGET}:${REMOTE_ROOT}"
RSYNC_EXCLUDES=(
  --exclude=target/
  --exclude=node_modules/
  --exclude=.git/
  --exclude='*.log'
  --exclude=.cargo/
  --exclude=bench-baremetal-report-*.md
  --exclude=FrameworkBenchmarks/
  --exclude=docs/superpowers/
)

if (( DRY_RUN )); then
  printf '  [dry-run] rsync -az --delete %s %s/ %s:%s/\n' \
    "${RSYNC_EXCLUDES[*]}" "$REPO_ROOT" "$SSH_TARGET" "$REMOTE_ROOT"
else
  run_remote "mkdir -p $REMOTE_ROOT"
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" \
    -e "ssh ${SSH_OPTS[*]}" \
    "$REPO_ROOT/" "$SSH_TARGET:$REMOTE_ROOT/"
fi

# ---------------------------------------------------------------------------
# Step 3: install deps (idempotent)
# ---------------------------------------------------------------------------
log "3/8 install host deps (docker, rust, bun, node, wrk)"
INSTALL_SCRIPT=$(cat <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Wait for any apt lock (cloud-init can hold it on first boot).
for _ in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then break; fi
  echo "  waiting for apt lock..."
  sleep 5
done

apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync build-essential pkg-config libssl-dev wrk

# Docker (ubuntu apt provides docker.io which is fine for bench)
if ! command -v docker >/dev/null; then
  apt-get install -y -qq docker.io docker-compose-plugin
  systemctl enable --now docker
fi

# Node 20+
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

# Bun (1.1+)
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# Rust 1.87+
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
fi
source "$HOME/.cargo/env" 2>/dev/null || true

echo "deps OK: docker=$(docker --version | head -c 40) node=$(node -v) bun=$(bun --version) cargo=$(cargo --version | head -c 40)"
REMOTE
)
run_remote_script "$INSTALL_SCRIPT"

# ---------------------------------------------------------------------------
# Step 4: build rust-core image + comparison apps
# ---------------------------------------------------------------------------
log "4/8 build rust-core docker image + comparison apps"
BUILD_SCRIPT=$(cat <<REMOTE
set -euo pipefail
export PATH="\$HOME/.bun/bin:\$HOME/.cargo/bin:\$PATH"
cd $REMOTE_ROOT

# Generate AOT handlers (needs Bun)
node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo

# Rust core image (single shared tag)
docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust-aot:dev .
docker builder prune -f >/dev/null 2>&1 || true

# Comparison: ntex (release build, takes a few minutes due to LTO)
( cd bench/comparison/ntex-rust && cargo build --release )

# Comparison: Bun apps
for app in bun-serve elysia-bun hono-bun; do
  ( cd bench/comparison/\$app && bun install )
done

echo "build OK"
REMOTE
)
run_remote_script "$BUILD_SCRIPT"

# ---------------------------------------------------------------------------
# Step 5: start Postgres for fearless harness
# ---------------------------------------------------------------------------
log "5/8 start bench Postgres (port 5433 for fearless harness, port 5432 host-direct for comparison)"
PG_SCRIPT=$(cat <<REMOTE
set -euo pipefail
cd $REMOTE_ROOT

# Bench compose at 5433 (used by run-bench.mjs)
./scripts/start-bench-postgres.sh

# Side Postgres at 5432 (host-network) for comparison apps; idempotent.
docker rm -f fearless-cmp-pg >/dev/null 2>&1 || true
docker run -d --name fearless-cmp-pg --network host \
  -e POSTGRES_USER=fearless -e POSTGRES_PASSWORD=fearless -e POSTGRES_DB=fearless_bench \
  postgres:16 -c port=5432 >/dev/null
# wait for readiness
for _ in \$(seq 1 30); do
  if docker exec fearless-cmp-pg pg_isready -U fearless -d fearless_bench >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i fearless-cmp-pg psql -U fearless -d fearless_bench < bench/techempower/seed.sql >/dev/null
echo "postgres OK"
REMOTE
)
run_remote_script "$PG_SCRIPT"

# ---------------------------------------------------------------------------
# Step 6: run fearless harness
# ---------------------------------------------------------------------------
log "6/8 run fearless harness (run-bench.mjs --quick)"
HARNESS_SCRIPT=$(cat <<REMOTE
set -euo pipefail
export PATH="\$HOME/.bun/bin:\$HOME/.cargo/bin:\$PATH"
cd $REMOTE_ROOT
node scripts/run-bench.mjs --quick --note "bare-metal AX102 first-run" 2>&1 | tee /tmp/fearless-harness.log
REMOTE
)
run_remote_script "$HARNESS_SCRIPT"

# ---------------------------------------------------------------------------
# Step 7: bench the four comparison apps
# ---------------------------------------------------------------------------
log "7/8 bench comparison apps (ntex / bun-serve / elysia / hono)"
COMPARISON_SCRIPT=$(cat <<REMOTE
set -euo pipefail
export PATH="\$HOME/.bun/bin:\$HOME/.cargo/bin:\$PATH"
cd $REMOTE_ROOT

results_json=/tmp/fearless-comparison.json
echo '{}' > \$results_json

run_one() {
  local name=\$1 start_cmd=\$2 port=\$3
  echo "--- \$name (port \$port) ---"
  bash -c "\$start_cmd" > /tmp/\${name}.log 2>&1 &
  local pid=\$!
  # wait for /plaintext to respond
  for _ in \$(seq 1 30); do
    if curl -fsS http://127.0.0.1:\$port/plaintext >/dev/null 2>&1; then break; fi
    sleep 1
  done

  for path in plaintext json db; do
    out=\$(wrk -t8 -c64 -d10s --latency http://127.0.0.1:\$port/\$path 2>&1 || true)
    rps=\$(echo "\$out" | awk '/Requests\/sec:/ {print \$2}')
    p99=\$(echo "\$out" | awk '/^ *99% / {print \$2}')
    echo "  /\$path  rps=\$rps  p99=\$p99"
    # append to JSON via jq if available, else printf
    if command -v jq >/dev/null; then
      tmp=\$(mktemp)
      jq --arg n "\$name" --arg p "\$path" --arg r "\$rps" --arg q "\$p99" \
        '.[\$n] = (.[\$n] // {}) | .[\$n][\$p] = {rps: \$r, p99: \$q}' \$results_json > \$tmp
      mv \$tmp \$results_json
    fi
  done

  kill \$pid 2>/dev/null || true
  wait \$pid 2>/dev/null || true
}

DB_URL=postgres://fearless:fearless@127.0.0.1:5432/fearless_bench

run_one ntex-rust   "DATABASE_URL=\$DB_URL BENCH_PORT=19001 \$REPO_ROOT/bench/comparison/ntex-rust/target/release/ntex-bench" 19001 || true
run_one bun-serve   "cd $REMOTE_ROOT/bench/comparison/bun-serve  && DATABASE_URL=\$DB_URL BENCH_PORT=19002 bun run server.ts" 19002 || true
run_one elysia-bun  "cd $REMOTE_ROOT/bench/comparison/elysia-bun && DATABASE_URL=\$DB_URL BENCH_PORT=19003 bun run server.ts" 19003 || true
run_one hono-bun    "cd $REMOTE_ROOT/bench/comparison/hono-bun   && DATABASE_URL=\$DB_URL BENCH_PORT=19004 bun run server.ts" 19004 || true

cat \$results_json
REMOTE
)
# REPO_ROOT inside heredoc — substitute before sending
COMPARISON_SCRIPT="${COMPARISON_SCRIPT//\$REPO_ROOT/$REMOTE_ROOT}"
run_remote_script "$COMPARISON_SCRIPT" | tee /tmp/comparison-output.txt || true

# ---------------------------------------------------------------------------
# Step 8: pull results, write report
# ---------------------------------------------------------------------------
log "8/8 build report → ${REPORT_FILE}"
if (( DRY_RUN )); then
  echo "  [dry-run] would scp ${SSH_TARGET}:${REMOTE_ROOT}/bench-history.json + /tmp/fearless-comparison.json → local"
  echo "  [dry-run] would synthesize ${REPORT_FILE}"
else
  scp "${SSH_OPTS[@]}" \
    "$SSH_TARGET:$REMOTE_ROOT/bench-history.json" "/tmp/fearless-history-${DATE_TAG}.json" || true
  scp "${SSH_OPTS[@]}" \
    "$SSH_TARGET:/tmp/fearless-comparison.json" "/tmp/fearless-comparison-${DATE_TAG}.json" || true

  {
    echo "# Fearless bare-metal bench report — ${DATE_TAG}"
    echo
    echo "Host: \`${SSH_TARGET}\`"
    echo "Generated: $(date -u +%FT%TZ)"
    echo
    echo "## Fearless harness (latest run)"
    echo
    if [[ -f "/tmp/fearless-history-${DATE_TAG}.json" ]]; then
      echo '```json'
      python3 -c "import json,sys; d=json.load(open('/tmp/fearless-history-${DATE_TAG}.json')); print(json.dumps(d['runs'][-1], indent=2))" 2>/dev/null \
        || cat "/tmp/fearless-history-${DATE_TAG}.json"
      echo '```'
    else
      echo "_history file not retrievable_"
    fi
    echo
    echo "## Comparison frameworks"
    echo
    if [[ -f "/tmp/fearless-comparison-${DATE_TAG}.json" ]]; then
      echo '```json'
      cat "/tmp/fearless-comparison-${DATE_TAG}.json"
      echo '```'
    else
      echo "_comparison results not retrievable; check /tmp/comparison-output.txt_"
    fi
  } > "$REPORT_FILE"

  log "report written: $REPO_ROOT/$REPORT_FILE"
  log "summary:"
  head -40 "$REPORT_FILE"
fi

log "done"
