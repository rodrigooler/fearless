# Deployment Tuning

This guide covers the host- and container-level knobs that materially change Fearless's performance on bare-metal Linux. The framework is fast out of the box, but the kernel defaults assume a generalist workload — these settings tell it you mean business.

If you ignore this guide, the framework still works. You'll just leave 2-5x throughput on the table at high load.

## TL;DR — copy-paste for benchmarks

```bash
# Host (run once, persist via /etc/sysctl.d/ + systemd-network)
sudo sysctl -w net.core.somaxconn=65535
sudo sysctl -w net.core.netdev_max_backlog=100000
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.core.rmem_max=16777216
sudo sysctl -w net.core.wmem_max=16777216

# Spread NIC IRQs across cores (replace eth0 with your NIC)
for irq in $(grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
  echo $((1 << (irq % $(nproc)))) | sudo tee /proc/irq/$irq/smp_affinity_list
done

# Enable Receive Packet Steering (RPS) — software fallback when NIC has fewer queues than CPUs
for q in /sys/class/net/eth0/queues/rx-*; do
  printf '%x\n' $(((1 << $(nproc)) - 1)) | sudo tee "$q/rps_cpus"
done

# Container (Fearless-specific flags)
docker run --rm \
  --ulimit memlock=-1 \
  --ulimit nofile=1048576:1048576 \
  --cap-add SYS_NICE \
  --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined \
  --network host \
  -e FEARLESS_SQPOLL_MS=2000 \
  fearless-rust
```

Read on for the why.

---

## 1. Sysctl knobs

These belong in `/etc/sysctl.d/99-fearless.conf` (or wherever your distro keeps them).

| Knob | Value | What it controls |
|---|---|---|
| `net.core.somaxconn` | 65535 | Maximum listen backlog. Default 4096-128 caps accept rate at high incoming-SYN load. The framework calls `listen(8192)` internally; the kernel clamps that to `somaxconn`. |
| `net.core.netdev_max_backlog` | 100000 | Per-CPU queue between NIC interrupt handler and protocol stack. Default ~1000. Drops during burst → connection failures that look like server bugs. |
| `net.ipv4.tcp_max_syn_backlog` | 65535 | SYN queue size before TCP handshake completes. Default 1024-2048 → SYN cookies kick in under load → measurable latency. |
| `net.ipv4.tcp_tw_reuse` | 1 | Allow reuse of TIME-WAIT sockets for outgoing connections. Useful if your server makes outbound calls (e.g. fetching from upstream) under high churn. |
| `net.ipv4.ip_local_port_range` | "1024 65535" | Range of ephemeral ports. Default 32768-60999 caps you at ~28k concurrent outbound connections. |
| `net.core.rmem_max` | 16777216 | Maximum receive buffer per socket. Fearless requests `1 << 20` (1 MiB) — kernel clamps to `rmem_max` if it's lower. |
| `net.core.wmem_max` | 16777216 | Same for send buffer. |
| `net.ipv4.tcp_fin_timeout` | 15 | (optional) Lower TIME-WAIT lifetime under high connection churn. Default 60s. |

**Apply at boot:**

```bash
cat <<EOF | sudo tee /etc/sysctl.d/99-fearless.conf
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 100000
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF
sudo sysctl --system
```

## 2. IRQ affinity

The single biggest perf win on multi-core hardware that nobody tunes by default.

When a packet arrives, the NIC raises an IRQ. The kernel handles it on whatever CPU was assigned for that IRQ. By default, **all NIC IRQs may land on CPU 0**. With our SO_REUSEPORT + CBPF distribution scheme, all incoming connections then route to the worker pinned to CPU 0, leaving the other N-1 workers idle.

### Check current state

```bash
cat /proc/interrupts | grep eth0
```

Look at the per-CPU columns. If only CPU0 has non-zero counts, IRQ affinity is broken.

### Fix it

Spread IRQs evenly:

```bash
# Multi-queue NIC (most modern hardware): one IRQ per RX queue
NIC=eth0
i=0
for irq in $(grep "${NIC}-rx" /proc/interrupts | awk '{print $1}' | tr -d ':'); do
  cpu=$((i % $(nproc)))
  echo $cpu | sudo tee /proc/irq/$irq/smp_affinity_list >/dev/null
  i=$((i + 1))
done

# Single-queue NIC: this won't help; jump to RPS below
```

Disable `irqbalance` if running — it's a generalist auto-tuner that conflicts:

```bash
sudo systemctl disable --now irqbalance
```

## 3. RPS / RFS — software receive steering

When your NIC has fewer queues than CPUs (or only one queue, like virtio-net in most VMs), enable RPS to spread packet processing in software.

### Receive Packet Steering (RPS)

```bash
# One mask per RX queue. ffff = any of the first 16 CPUs (adjust for nproc)
NIC=eth0
MASK=$(printf '%x' $(((1 << $(nproc)) - 1)))
for q in /sys/class/net/$NIC/queues/rx-*; do
  echo $MASK | sudo tee "$q/rps_cpus"
done
```

### Receive Flow Steering (RFS)

RFS is RPS with smart per-flow caching — packets for an established connection consistently land on the same CPU. Big win for long-lived connections (which is most of our workload).

```bash
sudo sysctl -w net.core.rps_sock_flow_entries=32768
NIC=eth0
for q in /sys/class/net/$NIC/queues/rx-*; do
  echo 4096 | sudo tee "$q/rps_flow_cnt"
done
```

### Verify

After a few seconds of load, check that softirq processing has spread:

```bash
mpstat -P ALL 1 5
# Watch %soft column — should be non-zero across multiple CPUs, not just CPU0
```

## 4. ulimits

The framework opens many file descriptors (one per connection). Default `ulimit -n 1024` caps you at ~1k concurrent connections.

```bash
# Per-process limits
ulimit -n 1048576
ulimit -l unlimited  # for io_uring registered buffers
```

For systemd services, in your `.service` file:

```ini
[Service]
LimitNOFILE=1048576
LimitMEMLOCK=infinity
```

## 5. Container runtime flags

If running Fearless inside Docker / Kubernetes / Podman, several kernel features need explicit pass-through:

| Flag | Why |
|---|---|
| `--ulimit memlock=-1` | io_uring registers buffers and ring memory; counts toward `RLIMIT_MEMLOCK`. Without this, the framework crashes on startup. |
| `--ulimit nofile=1048576:1048576` | High connection counts hit fd limits. |
| `--cap-add SYS_NICE` | Required for io_uring SQPOLL mode (kernel polling thread). Skip if you don't enable `FEARLESS_SQPOLL_MS`. |
| `--cap-add NET_ADMIN` | Required for `SO_ATTACH_REUSEPORT_CBPF` to install the CPU-distribution program. |
| `--security-opt seccomp=unconfined` | Some default seccomp profiles (Docker on macOS via OrbStack, older Podman defaults) block `io_uring_setup`. Crashes on startup with `Permission denied`. The "unconfined" profile is broad — for production, ship a custom profile that whitelists `io_uring_setup`, `io_uring_enter`, `io_uring_register`. |
| `--network host` | Bypasses the container NAT layer. Significant throughput improvement for bench-class loads (>1M req/s). For untrusted multi-tenant deploys, you want the NAT — keep host-network for benchmarking only. |

### Kubernetes equivalent

```yaml
spec:
  hostNetwork: true
  containers:
    - name: fearless
      securityContext:
        capabilities:
          add: ["SYS_NICE", "NET_ADMIN"]
        seccompProfile:
          type: Unconfined
      resources:
        limits:
          memory: "2Gi"
        requests:
          memory: "512Mi"
```

For seccomp, the cleaner production path is a custom Localhost profile that whitelists the io_uring syscalls — see `docker.io/cilium/example-seccomp` for a starting template.

## 6. Kernel version requirements

| Feature | Minimum kernel | Used by |
|---|---|---|
| Basic io_uring | 5.1 | Always |
| `setup_single_issuer` + `setup_defer_taskrun` | 6.0 | Default config (no SQPOLL) |
| `AcceptMulti` (multishot accept) | 5.19 | Default |
| `RecvMulti` + provided buffers | 6.0 | Future optimization |
| `register_buf_ring` | 5.19 | Future optimization |

`uname -r` should report ≥ 6.0 for the optimal path. Older kernels still work but the framework falls back to less efficient code paths.

## 7. CPU governor

Set `performance` governor on your CPUs to disable frequency scaling during load. Default `ondemand` introduces tail latency from frequency ramp-up.

```bash
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance | sudo tee "$cpu"
done
```

Persist via `cpupower` or your distro's CPU frequency service.

## 8. Verification — confirm your tuning works

After applying the above, run:

```bash
# Snapshot interrupt distribution before a load test
cat /proc/interrupts > /tmp/before.txt

# Run 30 seconds of load
wrk -t 16 -c 256 -d 30 http://your-server:8080/plaintext &

# After load completes
cat /proc/interrupts > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
# Expect: large IRQ count growth on multiple CPUs, NOT just CPU 0

# Check workers are spreading
top -H -p $(pgrep fearless-core)
# Expect: multiple `fearless-uring-N` threads, each at non-trivial CPU%
```

If all IRQ count growth is on CPU 0, IRQ affinity didn't take effect — re-check section 2.

If only 1-2 worker threads show high CPU%, RPS/RFS didn't take effect — re-check section 3.

## 9. Anti-patterns to avoid

- **`irqbalance` running alongside manual affinity** — they fight each other. Pick one, disable the other.
- **CPU affinity that doesn't match Fearless's worker pinning** — Fearless pins worker `i` to CPU `i`. If your IRQ affinity sends RX to CPUs 0-3 but you have 16 workers spanning 0-15, workers 4-15 will still be idle. Match the ranges.
- **`net.ipv4.tcp_tw_reuse` on a server that doesn't make outbound calls** — pure tuning theater. Helps clients, not idle servers.
- **`SO_BUSY_POLL` set to a large value globally** — burns one CPU spinning per socket. Use the `FEARLESS_BUSY_POLL_US` env knob (default 0) to enable selectively.
- **Setting `somaxconn` to 65535 but leaving `tcp_max_syn_backlog` at default** — the SYN queue overflows first; the listen backlog never gets exercised.

## 10. Why Fearless ships defaults that ignore most of this

The framework's default container config (`bench/techempower/fearless-rust.dockerfile`) sets the minimum required to start (`memlock`, `SYS_NICE`, etc.) but not the host-side tuning.

Reasons:
- Host tuning is operator-controlled, not container-controlled
- Aggressive defaults can hurt unexpected workloads (small-traffic deployments, multi-tenant containers)
- Operators who care about top-tier perf will tune; operators who don't, get reasonable defaults

This guide is the bridge: opt into the tuning when you want the throughput.
