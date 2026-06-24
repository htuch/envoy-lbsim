# Status

Living document. `/new-session` reads it to start; `/wrap-session` updates it.

## Now

Phase 0 (scaffolding) is complete. The repo builds, type checks, lints, and
tests green, and the hardest risk is retired: real Envoy v1.36.0 EDF compiles to
Wasm and runs. Next work is the four parallel tracks below; each is gated only on
the Phase 0 interfaces and mocks the others until they land.

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
  heap, Maglev table, hash ring into `LbInspection`).
- Golden tests vs the `lb_core` extract-track oracle for identical inputs.
Mocks until done: none (this is the real thing the mock stands in for).

### Track B: simulation kernel
Flesh out `sim-core` into the full DES.
- Open-loop client generators (Poisson/periodic/uniform; Zipf/uniform keys);
  client-side LB to Envoys; network-link delays; Envoy admission queues; backend
  capacity/latency/queue/health/locality models; timeouts and goodput.
- Emit the `RequestEvent` stream and write gauge frames into the ring buffers.
- Host the LB behind the Wasm ABI (use `mockLbModule` until Track A lands).
Mocks until done: the frontend consumes recorded/synthetic streams.

### Track C: frontend shell and hot path
- App layout and shadcn control panel; schema-driven config editor over
  `@elbsim/config`.
- uPlot timeline strips with brushing; playback transport (play/pause/step/seek/
  speed); zustand store; worker wiring (Comlink + SharedArrayBuffer ring buffers).
Mocks until done: drive from a synthetic telemetry stream behind `protocol`.

### Track D: topology, cold path, inspector
- `@xyflow/react` + dagre topology graph with live status; queue visualizations.
- Observable Plot analytical charts over a committed brushed window.
- The LB data-structure inspector rendering `LbInspection` (EDF heap, Maglev
  table, hash ring).
Mocks until done: synthetic `LbInspection` and window aggregates.

## Integration (after tracks)

Wire real Wasm into the kernel, the real kernel into the UI, and real inspection
payloads into the inspector. Add Playwright E2E around the core user journeys
(assemble scenario, run, brush a window, inspect an Envoy).

## Known follow-ups / decisions on the shelf

- abseil-via-CMake (`emcmake`) is an alternative to the curated source subset if
  cmake is added to the toolchain; not required.
- Retry handling (`timeouts.retries`, per-try timeout) is modeled in config but
  not yet exercised by the kernel.
- Subset LB and slow start are out of the initial lift (subset uses protobuf
  reflection; slow start needs a virtual TimeSource into the LB).
