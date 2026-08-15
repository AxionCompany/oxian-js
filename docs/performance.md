# Worker transport performance

Oxian 0.21 intentionally runs the complete `oxian.worker.v1` lifecycle, codec,
ordering validator, flow control, and cancellation logic for both built-in
transports. The in-process path avoids sockets, TCP, TLS, and kernel scheduling;
it does not bypass protocol semantics.

## Release benchmark

The release benchmark compares the previous direct local implementation, the new
addressed event fabric, and loopback WebSocket on the same process and machine.
It covers readiness startup, sequential five-byte work, batches of 16 concurrent
operations, and a streamed 1 MiB echo.

These are illustrative development measurements, not an SLA. The values below
are p50 wall-clock milliseconds from one 2026-08-09 run on arm64 macOS 26.0.1,
Deno 2.8.2. Startup had first-run/JIT outliers, so p50 is more representative
than its small-sample mean.

| Topology                | Startup | Small work | Concurrent work/op | Stream 1 MiB |
| ----------------------- | ------: | ---------: | -----------------: | -----------: |
| 0.20 direct local       |   0.223 |      0.140 |              0.038 |        0.577 |
| 0.21 event-fabric local |   0.947 |      0.170 |              0.156 |        1.502 |
| 0.20 loopback WebSocket |   1.334 |      0.473 |              0.329 |        4.943 |
| 0.21 loopback WebSocket |   1.024 |      0.495 |              0.339 |        5.321 |

The expected tradeoff is visible:

- the 0.21 local path pays for the canonical lifecycle that the old direct-call
  shortcut skipped;
- it remains materially lighter than loopback WebSocket for work and streamed
  data; and
- the WebSocket path stayed effectively flat across the lifecycle refactor,
  which is evidence that sharing the kernel did not introduce a second remote
  execution cost.

Do not infer zero-copy behavior from these numbers. Public payload semantics are
`Uint8Array` and Web Streams; implementations may copy where ownership or
runtime safety requires it.

## Reproduce

Check out `v0.20.0-rc.7` as a detached worktree, then run:

```sh
deno task bench:topology /path/to/v0.20.0-rc.7-worktree
```

The benchmark prints every mean, p50, and p95 sample as a table and one JSON
record suitable for retaining with release evidence. Compare ratios and memory
profiles under the intended application workload before making topology or codec
decisions from microbenchmarks alone.
