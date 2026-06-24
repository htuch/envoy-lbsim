# Convenience wrapper over the canonical pnpm / em++ commands. The pnpm scripts
# (see CLAUDE.md) remain the source of truth; this just saves keystrokes and
# documents the common entry points. `make` with no target prints help.
#
# Uses `>` as the recipe prefix instead of TAB (GNU make .RECIPEPREFIX).

.RECIPEPREFIX = >
.DEFAULT_GOAL := help

help: ## Show this help
> @grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
>   | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies and init submodules
> git submodule update --init
> pnpm install

dev: ## Run the web dev server
> pnpm --filter web dev

typecheck: ## Type check every package
> pnpm run typecheck

test: ## Run all tests
> pnpm run test

test-cov: ## Run tests with coverage (95% gate)
> pnpm -r run test:cov

lint: ## Lint and format (writes fixes)
> pnpm exec biome check --write .

ci: ## Mirror CI locally: lint check, types, coverage
> pnpm exec biome ci .
> pnpm run typecheck
> pnpm -r run test:cov

wasm: ## Build the Wasm LB module (needs an activated emsdk)
> pnpm run wasm:build

wasm-test: ## Build the Wasm LB and run the golden smoke
> pnpm --filter @elbsim/wasm-lb run test:wasm

build: ## Production build of the web app
> pnpm --filter web build

deploy: ## Build + deploy the web app to Cloudflare Pages (envoy-lb-sim.pages.dev)
> ./scripts/deploy.sh

clean: ## Remove build outputs and coverage
> rm -rf web/dist web/coverage packages/wasm-lb/build
> rm -rf packages/config/coverage packages/protocol/coverage packages/sim-core/coverage

.PHONY: help install dev typecheck test test-cov lint ci wasm wasm-test build deploy clean
