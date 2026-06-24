#!/usr/bin/env bash
#
# Build the envoy-lb-sim web bundle and deploy it to Cloudflare Pages as one
# same-origin static site (envoy-lb-sim.pages.dev). `vite build` produces the
# whole site (SPA shell, hashed JS/CSS, the sim worker, and the Wasm LB), so
# unlike some sibling projects there is no extra content tree to fold in before
# uploading.
#
# Auth is an API token, never an interactive wrangler OAuth session: deploys
# always target the account the token belongs to, so they can't silently land
# on whatever account `wrangler login` happens to be signed into. Set
# CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID when the token can see more
# than one account) in a gitignored repo-root `.env`; see .env.example. Set
# DRY_RUN=1 to build without uploading (no auth needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_PROJECT="${CF_PROJECT:-envoy-lb-sim}"
DIST="$ROOT/web/dist"
DRY_RUN="${DRY_RUN:-}"

# --- credentials -----------------------------------------------------------
if [[ -z "$DRY_RUN" ]]; then
  if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
  fi
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "CLOUDFLARE_API_TOKEN not set (copy .env.example to .env and fill it" >&2
    echo "in). Deploys are token-scoped on purpose; OAuth login is not used." >&2
    exit 1
  fi
  # Pin the deploy to the token's account, ignoring any wrangler OAuth session.
  export CLOUDFLARE_API_TOKEN
  unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL 2>/dev/null || true
  # wrangler caches the resolved account id under node_modules/.cache; a stale
  # entry from a previous deploy silently overrides CLOUDFLARE_ACCOUNT_ID and
  # sends the request to the wrong account. Drop it so .env always wins.
  rm -f "$ROOT/web/node_modules/.cache/wrangler/wrangler-account.json"
fi

# --- ensure the Pages project exists in the token's account ----------------
if [[ -z "$DRY_RUN" ]]; then
  if (cd "$ROOT/web" && pnpm exec wrangler pages project list 2>/dev/null) \
    | grep -qw "$CF_PROJECT"; then
    echo "==> Pages project $CF_PROJECT exists"
  else
    echo "==> Creating Pages project $CF_PROJECT"
    (cd "$ROOT/web" && pnpm exec wrangler pages project create "$CF_PROJECT" \
      --production-branch main)
  fi
fi

# --- build -----------------------------------------------------------------
echo "==> Building web bundle"
(cd "$ROOT" && pnpm --filter web build)

if [[ -n "$DRY_RUN" ]]; then
  echo "==> DRY_RUN set; skipping upload. Built site at $DIST"
  exit 0
fi

# --- deploy ----------------------------------------------------------------
echo "==> Deploying to Cloudflare Pages ($CF_PROJECT)"
(cd "$ROOT/web" && pnpm exec wrangler pages deploy dist \
  --project-name="$CF_PROJECT" --branch=main)
