# Cloudflare Pages deployment

Design for shipping the `web/` Vite app as a single static site on Cloudflare
Pages. The model is ported from the sibling project at `~/src/eario`, which
already deploys this way, with one substantive adaptation for this codebase.

## Goal

A human runs one command (`make deploy`) and the dashboard goes live on
Cloudflare Pages as one same-origin static site. Auth is an API token, never
an interactive OAuth session. CI stays validation-only; it does not upload.

## Why this differs from eario

eario and envoy-lb-sim share a stack (pnpm monorepo, Vite + React 19 in
`web/`, build to `web/dist`), so most of eario's deploy machinery ports
directly. Two differences shape this design:

1. envoy-lb-sim uses `SharedArrayBuffer` for the telemetry ring buffers shared
   with the sim worker. That requires the page to be cross-origin isolated,
   which means production must send `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp`. `web/vite.config.ts`
   already emits these in dev and preview and notes that "production hosting
   must send the same headers." eario does not use `SharedArrayBuffer` and so
   ships no such headers. For us they are mandatory: without them
   `SharedArrayBuffer` is undefined and the worker telemetry path breaks.

2. eario folds a separately-built static content tree (`content/dist`) into
   `web/dist` after the Vite build. envoy-lb-sim has no such tree; `vite build`
   produces the entire site, so the deploy script is correspondingly simpler.

## Decisions

- Deploys are manual only, run by a human via `make deploy`. CI validates
  (lint, types, tests, Wasm golden) and stops there. This matches eario and
  keeps deploy credentials out of CI.
- Auth is a Cloudflare API token loaded from a gitignored repo-root `.env`,
  never an interactive `wrangler login`. A token always targets the account it
  belongs to, so a deploy cannot silently land on whatever account wrangler
  happens to be signed into.
- Pure static hosting. No Pages Functions, no Workers, no edge middleware, no
  `wrangler.toml`; the deploy passes flags to the `wrangler` CLI directly, as
  eario does.
- An SPA catch-all redirect (`/*  /index.html  200`) is included so any future
  deep link resolves. It is costless even though the dashboard is currently a
  single page with no client-side router.

## Artifacts

### `web/public/_headers`

Vite copies `public/` verbatim into `dist/`, so this file is uploaded as-is and
Cloudflare Pages applies it as response headers. Contents:

- `/*` gets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Applying to `/*` (rather than
  only `index.html`) covers the document, the ES-module worker, and the `.wasm`
  so the whole same-origin site is cross-origin isolated. Same-origin
  subresources load fine under `require-corp` with no extra CORP header.
- `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`. Vite
  content-hashes everything it emits under `/assets/`, so those URLs are safe to
  cache forever; a new build produces new hashed URLs.
- A header comment ties the file back to `web/vite.config.ts` so the two header
  sources (dev/preview server vs production hosting) do not silently drift.

### `web/public/_redirects`

```
/*    /index.html   200
```

SPA catch-all. The 200 rewrite still serves `index.html`, which receives the
`/*` headers above, so isolation holds for deep links.

### `scripts/deploy.sh`

Ported from `~/src/eario/scripts/deploy.sh`, minus the content-tree fold (we
have none). Behavior, in order:

1. Unless `DRY_RUN` is set, source repo-root `.env`, require
   `CLOUDFLARE_API_TOKEN` (fail with guidance if unset), export it, unset
   `CLOUDFLARE_API_KEY`/`CLOUDFLARE_EMAIL`, and remove any stale
   `web/node_modules/.cache/wrangler/wrangler-account.json` so `.env` always
   wins over a cached account id.
2. Unless `DRY_RUN`, ensure the Pages project exists in the token's account,
   creating it (`wrangler pages project create "$CF_PROJECT" --production-branch
   main`) if `wrangler pages project list` does not show it. This makes the
   first deploy to a fresh account self-bootstrapping.
3. Build: `pnpm --filter web build` (which runs `tsc -b && vite build`).
4. If `DRY_RUN` is set, print the assembled `web/dist` path and exit 0 (no
   token needed).
5. Deploy: `wrangler pages deploy dist --project-name="$CF_PROJECT"
   --branch=main`, run from `web/`.

`CF_PROJECT` defaults to `envoy-lb-sim` and is overridable via env.

`set -euo pipefail`. The script is the single source of deploy logic; the
Makefile target is a one-line wrapper.

### `.env.example` (repo root)

Template with `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_ACCOUNT_ID` (needed
when the token can see more than one account), and an optional commented
`CF_PROJECT` override, each with the same guidance comments eario uses
(where to mint the token, the "Cloudflare Pages: Edit" permission, that `.env`
is gitignored).

### `.gitignore` (repo root)

Add `.env`. It is not currently ignored, and a real token must never be
committed.

### `Makefile` (repo root)

Add a `deploy` target that invokes `./scripts/deploy.sh`, with a `## ` help
string so it shows in `make help`, and add `deploy` to `.PHONY`. The Makefile
uses `.RECIPEPREFIX = >`, so the recipe line is prefixed with `>`.

### `web/package.json`

Add `wrangler` to `devDependencies` (matching the major version eario pins,
`^4`). `scripts/deploy.sh` invokes it via `pnpm exec wrangler`.

### `docs/DEPLOY.md`

Adapted from eario's deploy guide, covering:

- Auth: token-only and why; how to mint the token.
- First deploy to a fresh account: self-bootstrapping project creation.
- Custom domain notes (CNAME, apex flattening) carried over from eario.
- `make deploy` and what the script does.
- `DRY_RUN=1 make deploy` to build and assemble without uploading, and how to
  eyeball the exact bytes with a dumb static server (`python3 -m http.server
  --directory web/dist`). Note that `pnpm preview` sets COOP/COEP itself and so
  would mask a missing `_headers`; the dumb server does not, making it the
  honest check.
- A dedicated note on the cross-origin isolation requirement: the app needs
  COOP/COEP in production for `SharedArrayBuffer`; `_headers` provides them; how
  to verify (`crossOriginIsolated === true` in the deployed page's console, or
  inspect the response headers).

## Out of scope (YAGNI)

- CI auto-deploy. Deploys are manual by choice.
- Pages Functions / Workers / `wrangler.toml`. Pure static hosting.
- Building the Wasm LB into the deploy path. The real Wasm module
  (`packages/wasm-lb`) is not yet wired into the web build (the kernel still
  uses `mock-lb`, per STATUS Track A). When it is, the `.wasm` must be built
  (`pnpm run wasm:build`, needs an activated emsdk) and bundled before deploy.
  Because it is served same-origin, COEP `require-corp` serves it without any
  extra header. This prerequisite is documented in `DEPLOY.md`, not wired into
  `deploy.sh`, so the deploy path does not grow an emsdk dependency before it is
  needed.

## Testing and acceptance

Deploy tooling is shell plus static config; the real upload needs a live token
this environment does not have. Acceptance is therefore:

1. `DRY_RUN=1 make deploy` exits 0 and produces `web/dist` containing both
   `_headers` and `_redirects`.
2. A dumb static server pointed at `web/dist` returns
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on `/` and on an `/assets/*`
   URL, and the immutable `Cache-Control` on `/assets/*`. (Note: `python3
   -m http.server` does not itself honor Pages `_headers`; verify the file
   contents are present in `dist` and document that Pages applies them. A true
   end-to-end header check requires a real Pages deploy.)
3. `shellcheck scripts/deploy.sh` is clean.
4. Existing `make ci` (lint, types, coverage) stays green.
