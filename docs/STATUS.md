# Status

Living document. `/new-session` reads it to start; `/wrap-session` updates it.

## Now

Phase 0 (scaffolding) is complete and Track B (simulation kernel) is done.
`sim-core` is now a full discrete-event simulation that drives the request
lifecycle end to end, emits the `RequestEvent` stream, writes hot-path gauge
frames into the ring buffers, and exposes the worker `SimWorkerApi` via
`SimController`. It hosts the upstream LB behind the Wasm ABI using
`mockLbModule` until Track A lands. The repo builds, type checks, lints, and
tests green under the 95% coverage gate.

Remaining work is Tracks A, C, D plus integration. Each is gated only on the
Phase 0 interfaces and mocks the others until they land. The concrete next step
is under "Next step" below.

## Phase 0: scaffolding and interfaces (DONE)

- pnpm workspace; Vite + React 19 app in `web/`; packages `config`, `protocol`,
  `sim-core`, `wasm-lb`.
- Envoy (`v1.36.0`) and abseil (`20260107.1`) added as pinned submodules.
- Tooling: Biome, strict TypeScript, Vitest + 95% coverage gate, lefthook hooks,
  GitHub Actions CI (TS job + Wasm build/golden job + secret scan).
- Durable interfaces written and tested: `SimConfig` schema; event stream;
  gauge ring-buffer layout; worker RPC; Wasm LB ABI; inspection payload.
- `sim-core` foundation: deterministic PRNG, distribution sampling, virtual-time
  event queue, kernel skeleton, and a mock LB implementing the Wasm ABI.
- `wasm-lb`: shim ported from `~/src/lb_core`; Embind EDF smoke module builds to
  Wasm and passes a golden distribution test (real Envoy EDF -> Wasm -> Embind
  -> node).
- App shell renders the default scenario from the shared config.

## Tracks (parallelizable; depend only on Phase 0 interfaces)

### Track A: Wasm LB core
Lift the real Envoy policies to Wasm behind the `LbInstance` ABI.
- Add the upstream-interface shim layer (see `lb_core` README sections 6, 13)
  and wire the abseil source subset to `em++`.
- Lift Maglev and ring_hash (thread-aware/table policies), then round_robin,
  least_request, random (EDF/host-set policies). Provide proto-shaped config
  structs so the real `.cc` compiles unmodified.
- Implement `createLb`/`updateHosts`/`chooseHost` and `inspect` (serialize EDF
  heap, Maglev table, hash ring into `LbInspection`). `inspect` only serializes
  the live structures; addressing a past instant is the worker's job via
  deterministic replay (see Design decisions).
- least_request needs live active-request counts at pick time; the kernel
  already supplies them on `WasmHost.activeRequests` (see Design decisions).
- Golden tests vs the `lb_core` extract-track oracle for identical inputs.
Mocks until done: none (this is the real thing the mock stands in for).

### Track B: simulation kernel (DONE)
`sim-core` is the full DES. Key files: `engine.ts` (the lifecycle),
`controller.ts` (`SimWorkerApi`), `histogram.ts` (latency), `sampling.ts`
(`createKeySampler`).
- Open-loop client generators (Poisson/periodic/uniform; uniform/cached-Zipf
  keys); client-side LB to Envoys (round_robin/random/hash/subset/dns_approx);
  network legs with a cross-zone penalty; Envoy admission (circuit breaker +
  FIFO/LIFO overflow queue); backend service (capacity/queue/health/per-host
  active counts/service latency); timeouts and goodput.
- Emits the `RequestEvent` stream; writes per-entity gauge frames each
  `sampleIntervalMs`, including appended latency percentile columns.
- Hosts the LB behind the Wasm ABI via `mockLbModule`. `SimController` does
  play/pause/step/seek (backward seek = deterministic replay into the same
  shared buffers), `queryWindow` (cohort-based cold-path aggregates), and
  `requestInspection` (replay-to-T then `inspect()`).
- Not yet exercised here: retries (see follow-ups); zone-aware locality LB
  routing logic (locality is plumbed through the ABI, but routing is left to
  Track A); least_request weighting (the mock falls back to round_robin, but the
  engine feeds live per-host active counts so the real policy will work).

### Track C: frontend shell and hot path
- App layout and shadcn control panel; schema-driven config editor over
  `@elbsim/config`.
- uPlot timeline strips with brushing; playback transport (play/pause/step/seek/
  speed); zustand store; worker wiring (Comlink + SharedArrayBuffer ring buffers).
Mocks until done: drive from a synthetic telemetry stream behind `protocol`.

### Track D: topology, cold path, inspector
- `@xyflow/react` + dagre topology graph with live status; queue visualizations.
- Observable Plot analytical charts over a committed brushed window (latency
  CDF/histogram, goodput breakdown) from `queryWindow` aggregates.
- The LB data-structure inspector rendering `LbInspection` (EDF heap, Maglev
  table, hash ring). Inspecting Envoy E at time T calls `requestInspection`,
  which uses deterministic replay to reach T (see Design decisions).
Mocks until done: synthetic `LbInspection` and window aggregates.

## Next step

Pick up Track C (frontend hot path) or Track A (real Wasm LB); both can now run
against a real `SimController` instead of synthetic streams.
- Track C: wire `web/` to a Web Worker that `Comlink.expose`s a `SimController`,
  read the returned `SharedTelemetry` ring buffers in the uPlot render loop, and
  bind the playback transport to play/pause/step/seek/setSpeed. `sim-core`
  already produces real frames and the cold-path `queryWindow`/inspection.
- Track A: replace `mockLbModule` with the real Wasm `LbModule`; the engine
  already feeds `WasmHostSet` (live per-host `activeRequests`, health, locality)
  and calls `updateHosts`/`chooseHost`/`inspect` per the ABI.

## Integration (after tracks)

Wire real Wasm into the kernel, the real kernel into the UI, and real inspection
payloads into the inspector. Add Playwright E2E around the core user journeys
(assemble scenario, run, brush a window, inspect an Envoy).

## Design decisions (settled)

- LB inspection / time travel: on-demand deterministic replay, not stored
  snapshots. To inspect Envoy E at virtual time T, replay the deterministic run
  to T and call `inspect()`; paused at the cursor that is just `inspect()` with
  no replay. SimController's backward seek and `requestInspection` both work this
  way (the run is a pure function of the seed). EDF state mutates every pick and
  a 65537-slot Maglev table is too heavy to snapshot continuously; periodic
  Wasm-heap checkpoints to bound replay cost are deferred until replay latency is
  shown to hurt.
- Cold-path latency over a brushed window: scan the `RequestEvent` stream via
  `SimWorkerApi.queryWindow` -> `WindowAggregate` (`latencyP50/P90/P99`, goodput,
  success/timeout/rejected). Implemented cohort-based on the requests emitted in
  the window, so goodput is not understated at the trailing edge.
- Hot-path (live) latency timeline (resolved in Track B): a fixed
  log-scale-bucket histogram per Envoy and backend (`histogram.ts`), decayed once
  per sample tick (factor 0.6), feeding the appended latency gauge columns.
  Chosen over per-sample-interval percentiles for robustness on sparse intervals.
- least_request active-count transport (resolved in Track B): the engine keeps
  live per-Envoy per-backend active counts and refreshes the host set via
  `updateHosts` before each pick, so `WasmHost.activeRequests` is current at
  `chooseHost` time. No ABI change was needed.

## Known follow-ups / decisions on the shelf

- abseil-via-CMake (`emcmake`) is an alternative to the curated source subset if
  cmake is added to the toolchain; not required.
- Retry handling (`timeouts.retries`, per-try timeout) is modeled in config but
  not yet exercised by the kernel. Track B left it deferred.
- Subset LB and slow start are out of the initial lift (subset uses protobuf
  reflection; slow start needs a virtual TimeSource into the LB).
