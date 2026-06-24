# Architecture

Read this and `STATUS.md` before starting work. `PRD.md` holds the why.

## Shape

A pnpm workspace monorepo. The browser app and a set of shared TypeScript
packages, plus a C++/Wasm package that compiles Envoy's real load balancer.

```
web/                  Vite + React dashboard (the only frontend)
packages/
  config/             SimConfig schema (Zod) + types: the single source of truth
  protocol/           durable cross-component contracts (events, ring buffers,
                      worker RPC, Wasm ABI types, inspection payloads)
  sim-core/           deterministic discrete-event kernel (TS), runs in a Worker
  wasm-lb/            Envoy LB compiled to Wasm via a shim + Embind ABI
  cli/                headless Node CLI (bin `elbsim`): drives the kernel without
                      the frontend; runs the per-LB validation suite
third_party/
  envoy/              git submodule, pinned to v1.36.0
  abseil-cpp/         git submodule, pinned to 20260107.1 (matches Envoy)
```

The `packages/*` boundaries are deliberate: they are the seams along which
independent work proceeds in parallel. `config` and `protocol` are pure
contracts that everything else depends on and that change rarely; the other
packages depend on them and can be built against mocks. `cli` is a pure consumer:
it drives `SimController`/`SimEngine` in-process (no Worker, no SAB), which is why
`SimController` exposes synchronous `loadConfigSync`/`queryWindowSync` cores
alongside the async `SimWorkerApi` methods that delegate to them.

## Core design decisions

### 1. The Envoy LB runs as real C++ in Wasm; everything else is TypeScript

The discrete-event simulation kernel (virtual clock, clients, network links,
Envoy admission queues, backend service models, timeouts, goodput accounting)
is plain TypeScript in `sim-core`, running in a Web Worker. Each Envoy replica's
load balancer lives in Wasm, compiled from Envoy's actual source: not just the
policy and its data structures (the Maglev table, the EDF heap, the hash ring)
but Envoy's real `LoadBalancerBase` / `ThreadAwareLoadBalancerBase` too, so
priority selection, panic-mode threshold, healthy/degraded partitioning,
locality weighting, and weight normalization are Envoy's own code, not a TS
re-implementation. The kernel determines host membership and health and feeds
the full host set across the ABI (`updateHosts`); the lifted base resolves it
and picks per request (`chooseHost`). See `packages/wasm-lb/shim` for the
include-shadowing layer that lets the real base compile against lightweight leaf
interfaces; the request-hashing HTTP path is the one stubbed subsystem (the
kernel supplies the hash directly).

Why: the LB algorithms are where fidelity matters and where subtle bugs live
(weighted-RR EDF behavior, Maglev disruption, P2C least-request). Compiling the
real code removes the risk of a re-implementation drifting from Envoy. The
surrounding simulation is straightforward to model faithfully in TS, is easy to
seed deterministically, and keeps the Wasm build small. It also isolates the
novel capability (inspecting LB structures in Wasm memory) to exactly the
component that warrants it.

### 2. Config crosses the Wasm boundary as plain structs (Embind), not protobuf

`config` (Zod) is the single source of truth. The kernel translates the relevant
slice of a `SimConfig` into flat C++ structs handed to the LB through Embind.
The few Envoy proto accessors the LB `.cc` files call (for example
`maglev.table_size()`) are satisfied by hand-written minimal "proto-shaped" C++
structs that expose the same method names, so the real Envoy code compiles
unmodified without linking the protobuf runtime. This keeps the module small and
the ABI simple. See `packages/protocol/src/wasm-abi.ts` for the TS view of the
ABI.

### 3. Visualization is split hot vs cold

- Hot path (live playback and brushing): `uPlot` (canvas) for the timeline
  strips. It handles up to ~10^6 points/series at 60fps and has built-in
  zoom/cursor; brushing is a plugin. The kernel writes per-entity gauges into
  `SharedArrayBuffer`-backed ring buffers (see `packages/protocol/src/snapshots.ts`)
  and the render loop reads the visible window directly, never routing 60fps
  frames through React.
- Cold path (analysis of a committed brushed window): `Observable Plot` (SVG)
  for expressive analytical charts (distributions, CDFs, faceted comparisons,
  heatmaps) over data pre-aggregated to a few thousand points, re-rendered on
  selection-commit, not per frame.

This is an architectural boundary, not redundancy: canvas owns the high-frequency
layer, SVG owns the expressive layer. The topology graph uses `@xyflow/react`
(read-only) laid out left-to-right with `@dagrejs/dagre`. Dense animated layers
(requests in flight) use a Canvas overlay, escalating to WebGL only if needed.

The frontend (`web/`) talks only to the `SimWorkerApi` Comlink contract, never
to a kernel directly. `sim-core`'s kernel worker (Track B) is built, but the web
app is not yet wired to it; until that integration lands, a synthetic worker
(`web/src/worker/mock-sim-worker.ts`) implements the same interface: it
allocates the SAB rings and paces deterministic gauge frames into them under
transport control, so the hot-path render loop and config editor run against the
real contract. The kernel worker is a drop-in swap at one URL in
`web/src/worker/client.ts`. This mirrors how `sim-core/mock-lb.ts` stands in for
the Wasm LB: scaffolds live behind the durable interface, never alongside it.

### 4. Reproducible Wasm build via submodules + em++ (no Bazel, no CMake)

Envoy and abseil are pinned git submodules. The Wasm module is built with a
hand-written Makefile driving `em++` directly. The key trick (proven in the
prior feasibility study at `~/src/lb_core`) is include-shadowing: a small `shim/`
directory provides lightweight versions of Envoy's leaf interface headers, and
the include order (`-Ishim -Ithird_party/envoy`) makes them shadow Envoy's heavy
ones while the real implementation files compile untouched. abseil (which most
Envoy code pulls in) compiles to Wasm from a curated source subset; EDF is
abseil-free.

Note on tooling: the original plan said "emcmake CMake", but this environment
has no `cmake` installed and the proven `lb_core` build uses `em++` + a Makefile
with zero loss of capability, so we build that way. If the abseil-via-CMake route
is wanted later (its own `CMakeLists.txt` under `emcmake`), it can be added once
cmake is available; the curated-source-subset approach needs only `em++`.

## Discrete-event kernel

`sim-core` is a virtual-time DES. `EventQueue` is a binary min-heap keyed by
virtual time with FIFO tie-breaking; `SimKernel` drains it in time order,
dispatching events that may schedule further events. `Prng` is a portable
SplitMix64 so the same seed reproduces a run (and can be mirrored in C++ where
the LB draws randomness). `sampling.ts` turns config distributions into draws.

Request lifecycle (each transition is an event and, for the cold path, a
`RequestEvent`): client emit -> client routes to an Envoy -> Envoy admission
queue -> LB picks a backend (Wasm) -> backend service (capacity + latency +
queue) -> completion or timeout/shed. Timeouts are checked in virtual time and
attributed to goodput. `engine.ts` (`SimEngine`) implements this lifecycle and
the entity models; `controller.ts` (`SimController`) wraps it as the worker
`SimWorkerApi` (playback, backward-seek replay, `queryWindow`, inspection).
Per-entity hot-path latency uses a decaying log-bucket histogram
(`histogram.ts`) feeding the appended latency gauge columns.

`mock-lb.ts` implements the Wasm LB ABI in pure TS (round-robin / hash-modulo)
so kernel and frontend work proceeds before the real Wasm module lands. It is a
scaffold, never the production LB.

## Durable interfaces (the contracts parallel work depends on)

- `@elbsim/config`: `SimConfig` and its sub-schemas. Field names mirror Envoy.
- `@elbsim/protocol`:
  - `events.ts`: the `RequestEvent` stream (cold path).
  - `snapshots.ts`: gauge column schemas per entity kind and the
    `GaugeRingBuffer` layout (hot path, SharedArrayBuffer).
  - `worker-rpc.ts`: the Comlink `SimWorkerApi` (load/play/pause/step/seek/
    query/inspect) and the shared-buffer handles.
  - `wasm-abi.ts`: the `LbInstance` / `LbModule` Embind surface.
  - `inspection.ts`: the `LbInspection` payload the inspector renders (EDF heap,
    Maglev table, hash ring).

Treat these as versioned. Appending fields is safe; changing shapes is a
coordinated breaking change.

## Build, test, run

See `CLAUDE.md` for the exact commands. The TS workspace lints with Biome, type
checks with strict TypeScript, and tests with Vitest under a 95% coverage gate.
The web app additionally has a Playwright E2E suite (`web/e2e/`, run with
`pnpm --filter web test:e2e`) for the behaviors units cannot prove: real uPlot
canvas rendering, the live brush highlight, and SharedArrayBuffer cross-origin
isolation. Vitest is scoped to `src/**/*.test.*` so it ignores the E2E specs.
The Wasm module builds with `em++` (needs an activated emsdk) and is verified by
golden node tests (run by `pnpm --filter @elbsim/wasm-lb test`): `test/maglev.mjs`
matches the `lb_core` oracle slot-for-slot and checks the lifted real base (health
filtering, panic mode, priority failover); `test/ring_hash.mjs` checks the real
ketama ring (consistent routing, weight-proportional ownership, minimal disruption,
xx_hash vs murmur_hash_2); `test/edf.mjs` checks round_robin/least_request/random
(weighted rotation, active-request preference off the live `rq_active_` stat,
uniform spread). `test/smoke.mjs` remains the minimal EDF toolchain proof.
Separately, `packages/sim-core/src/engine.wasm.test.ts` drives the real `SimEngine`
with the real Wasm `LbModule` for every policy (an integration test that skips when
the artifact is not built). CI builds the module in a dedicated job (emsdk action)
and runs the golden tests.

## Visual design principle

The UI must be high signal-to-noise with depth on demand: dense, legible, fast,
and honest about uncertainty, without burying the user in chrome. Build UI with
the frontend-design skill. Favor tabular numerals, tight layouts, and direct
manipulation (brushing, clicking an entity to inspect) over modal navigation.
