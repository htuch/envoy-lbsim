# Envoy LB Simulator

A browser tool to simulate, visualize, and explore Envoy's load balancing
behavior. Its distinguishing bet: each Envoy replica's load balancer is Envoy's
real C++ compiled to WebAssembly (not a re-implementation), driven over virtual
time by a TypeScript discrete-event kernel. See docs/PRD.md for the full why.

## Stack & structure (WHAT)

- pnpm workspace monorepo. TypeScript everywhere except the LB, which is C++
  compiled to Wasm with Emscripten.
- `web/`: Vite + React 19 dashboard. Tailwind v4 + shadcn/ui; uPlot (live,
  brushable timelines) and Observable Plot (analytical charts); @xyflow/react +
  dagre (topology); zustand; Comlink + SharedArrayBuffer to the sim worker.
- `packages/config`: SimConfig (Zod), the single source of truth.
- `packages/protocol`: durable contracts (event stream, ring-buffer layout,
  worker RPC, Wasm LB ABI, inspection payload).
- `packages/sim-core`: deterministic virtual-time kernel (runs in a Web Worker).
- `packages/wasm-lb`: Envoy LB compiled to Wasm via an include-shadowing shim +
  Embind ABI.
- `third_party/envoy` (v1.36.0) and `third_party/abseil-cpp` (20260107.1) are
  pinned submodules. Run `git submodule update --init` after cloning.
- Context bank: docs/PRD.md (why), docs/ARCHITECTURE.md (structure and the key
  decisions), docs/STATUS.md (what is done and what is next). Read
  ARCHITECTURE.md and STATUS.md before starting work.

## Commands (HOW)

- Convenience targets: `make help` (thin wrappers over the commands below).

- Install: `pnpm install`
- Dev server: `pnpm --filter web dev`
- Lint / format: `pnpm exec biome check --write .` (CI: `pnpm exec biome ci .`)
- Type check: `pnpm run typecheck`
- Test: `pnpm run test` (coverage: `pnpm -r run test:cov`, 95% gate)
- Build Wasm LB (needs an activated emsdk; set EMSDK_ENV if not at ~/emsdk):
  `pnpm run wasm:build`; golden smoke: `pnpm run wasm:test`
- Build web: `pnpm --filter web build`

## Core principle

Visualization must be high signal-to-noise with depth on demand: dense, legible,
fast, honest. Build UI with the frontend-design skill. The simulation is
deterministic from `SimConfig.seed`; keep it that way.
