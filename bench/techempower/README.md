# Fearless Rust target

Run with:

    docker run --rm --ulimit memlock=-1 --cap-add SYS_NICE -p 8080:8080 fearless-rust

`FEARLESS_SQPOLL_MS=2000` enables io_uring SQPOLL with 2s idle timeout.
Set `FEARLESS_SQPOLL_MS=0` to disable SQPOLL (e.g. for environments without `SYS_NICE`).

`FEARLESS_WORKERS` overrides the per-thread worker count. When unset, the
runtime spawns one worker per available CPU.

## Required runtime capabilities

- `--ulimit memlock=-1` — io_uring registered files / fixed buffers count toward `RLIMIT_MEMLOCK`.
- `--cap-add SYS_NICE` — needed for SQPOLL kernel thread. Drop the cap and set `FEARLESS_SQPOLL_MS=0` if your environment forbids it.

## Kernel requirements

- Linux >= 5.19 for multishot accept (`AcceptMulti`).
- Linux >= 5.13 for SQPOLL with the simplified API the runtime uses.
- TFB Citrine class hardware easily meets these.
