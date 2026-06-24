# Deploying to Cloudflare Pages

The envoy-lb-sim web app is a single static site served from one origin on
Cloudflare Pages (`envoy-lb-sim.pages.dev`). There is no backend: the
simulation runs entirely in the browser. Deploys are manual only. A human runs
`make deploy`, which builds `web/` and uploads `web/dist` via Wrangler using a
Cloudflare API token. CI never uploads.

## Cross-origin isolation (read this first)

This is the project-specific gotcha. The app shares telemetry ring buffers
with the sim Web Worker through `SharedArrayBuffer`. Browsers only expose
`SharedArrayBuffer` to a page that is *cross-origin isolated*, which requires
two response headers on the document:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Without them, `SharedArrayBuffer` is `undefined` in production and the app
breaks outright. There is no graceful degradation.

These headers ship from `web/public/_headers`. Vite copies everything under
`web/public/` into `web/dist/` verbatim, and Cloudflare Pages applies a
`_headers` file at the deployment root. This mirrors the headers that
`web/vite.config.ts` sets for the dev and preview servers, so dev and
production agree.

The Envoy LB `.wasm` is served same-origin, so it loads fine under
`Cross-Origin-Embedder-Policy: require-corp` with no extra per-resource header.
(See "Building the Wasm LB before deploy" below: it must be built first or the
deploy ships a non-functional worker.)

Verify after a deploy:

- Open the deployed page, then in the devtools console check
  `crossOriginIsolated === true`.
- Or inspect the document's response headers (devtools Network tab, or
  `curl -I https://envoy-lb-sim.pages.dev/`) and confirm both COOP and COEP
  are present with the values above.

## Authentication

Deploys authenticate with a Cloudflare API token, never interactive
`wrangler login`. Rationale: a token is scoped to the account it belongs to, so
a deploy cannot silently land on the wrong account. An interactive login can.

Mint a token:

1. Go to https://dash.cloudflare.com/profile/api-tokens.
2. Create a token with the "Cloudflare Pages: Edit" permission.
3. Copy `.env.example` to `.env` at the repo root and set:

       CLOUDFLARE_API_TOKEN=...

   If the token can see more than one account, also set the target account so
   Wrangler does not have to guess:

       CLOUDFLARE_ACCOUNT_ID=...

`.env` is gitignored and lives at the repo root. `scripts/deploy.sh` loads it.

## First deploy to a fresh account

The deploy script is self-bootstrapping. On the first run it creates the
`envoy-lb-sim` Pages project (`envoy-lb-sim.pages.dev`) in the token's account
if it does not already exist, then deploys. So a first deploy needs nothing
beyond a populated `.env`. There is no manual project-creation step in the
dashboard.

## Custom domain

Pages projects are reachable at `*.pages.dev` by default. To serve from your
own hostname:

1. In the Cloudflare dashboard, open the `envoy-lb-sim` Pages project and add
   the domain under Custom domains.
2. Point the hostname at `envoy-lb-sim.pages.dev`.

DNS specifics:

- A subdomain (e.g. `sim.example.com`) is a plain `CNAME` to
  `envoy-lb-sim.pages.dev`.
- An apex / root domain (e.g. `example.com`) cannot use a literal `CNAME`
  (that is invalid DNS). It needs a provider that supports CNAME flattening,
  `ALIAS`, or `ANAME`. If the domain is on Cloudflare DNS, this is handled for
  you.

Cloudflare validates the domain over HTTP and issues TLS automatically.

## Deploying

    make deploy

That runs `scripts/deploy.sh`, which:

1. Builds the web app: `pnpm --filter web build` into `web/dist`.
2. Uploads it:
   `wrangler pages deploy dist --project-name=envoy-lb-sim --branch=main`.

Cache policy also comes from `web/public/_headers`: `/assets/*` is served
immutable with a one-year max-age, which is safe because Vite content-hashes
those filenames. The HTML entry point is not cached aggressively, so new
deploys are picked up immediately. SPA routing comes from
`web/public/_redirects`, which has a catch-all
(`/*  /index.html  200`) so client-side routes resolve to the app shell.

## Verifying a build without uploading

To build without touching Cloudflare (no token required):

    DRY_RUN=1 make deploy

This produces `web/dist` and stops before the upload step.

To eyeball the exact bytes that would ship, point a dumb static server at the
output:

    python3 -m http.server 8791 --directory web/dist

Caveat, important: neither local method proves the production headers.

- The `python3 -m http.server` server does NOT apply the Pages `_headers`
  file. It just serves files. So `crossOriginIsolated` will be `false` there
  even though the headers shipped into `dist`.
- `pnpm preview` (vite preview) DOES set COOP/COEP, but from
  `web/vite.config.ts`, not from the `_headers` file. So a passing isolation
  check under `vite preview` only proves Vite's dev/preview config, not what
  Cloudflare will send.

Both local methods only confirm that `_headers` and `_redirects` were copied
into `web/dist`. The true end-to-end cross-origin-isolation check requires
inspecting the response headers of the real Cloudflare Pages deployment (see
"Cross-origin isolation" above).

## Building the Wasm LB before deploy

The real Envoy LB Wasm drives the production worker, so the `.wasm` is a build
artifact that must exist before the web build bundles it. `web/vite.config.ts`
copies `packages/wasm-lb/build/lb.wasm` into the output; if it is missing the
build still succeeds but logs a warning and ships a non-functional worker (the
app loads but no policy can pick a host).

So a real deploy has one prerequisite beyond `.env`: build the Wasm first with
an activated emsdk via `pnpm run wasm:build` (it self-bootstraps the Envoy and
abseil submodules), then run `make deploy` so the freshly built `.wasm` is
bundled into `web/dist`. `scripts/deploy.sh` does not build the Wasm itself, so
skipping this step is the most likely way to ship a broken site.
