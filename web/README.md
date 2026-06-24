# web

The dashboard for the Envoy LB simulator: a Vite + React 19 single-page app
that drives the simulation worker and renders the visualizations. It is the
only frontend in the monorepo. See the repo root `README.md` for the project
overview and `docs/ARCHITECTURE.md` for how this app fits the whole.

## What is here

- `src/components/` the views: `timeline/` (uPlot hot-path strips),
  `topology/` (@xyflow graph), `analysis/` (Observable Plot cold-path charts),
  `inspector/` (LB data-structure inspector), `config/` (schema-driven editor),
  `transport/` (playback controls), `views/` (the C-D view switcher), `ui/`
  (shadcn primitives).
- `src/worker/` the Comlink + SharedArrayBuffer bridge to the sim worker.
  Today it spins up a synthetic telemetry worker (`mock-sim-worker.ts`) that
  implements the real `SimWorkerApi`; the kernel worker is a drop-in swap at
  one URL in `client.ts` once integration lands (see `docs/STATUS.md`).
- `src/synthetic/` deterministic data generators that feed the analytical
  views until they read real worker telemetry.
- `src/store/` the zustand store mirroring worker state.
- `e2e/` Playwright specs for what units cannot prove (real canvas rendering,
  the live brush highlight, cross-origin isolation).

## Commands

Run these from the repo root (a pnpm workspace):

```sh
pnpm --filter web dev            # dev server (sets COOP/COEP for SharedArrayBuffer)
pnpm --filter web build          # production build into web/dist
pnpm --filter web test           # Vitest unit tests (src/**/*.test.*)
pnpm --filter web test:e2e       # Playwright E2E (test:e2e:install once first)
```

Lint, format, and type-check run repo-wide; see the root `CLAUDE.md`.

## Notes

- The app must be cross-origin isolated for `SharedArrayBuffer`. The dev and
  preview servers set COOP/COEP from `vite.config.ts`; production ships them
  from `public/_headers`. See `docs/DEPLOY.md`.
- Linting and formatting are Biome (repo root), not ESLint or Oxlint.
