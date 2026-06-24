#!/usr/bin/env bash
# Ensure the Envoy + abseil submodules are checked out before building. Shallow
# (depth 1) to keep the Envoy clone small. Idempotent: a no-op once present.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
for sm in third_party/envoy third_party/abseil-cpp; do
  if [ ! -e "$root/$sm/.git" ] && [ -z "$(ls -A "$root/$sm" 2>/dev/null)" ]; then
    echo "[wasm-lb] initializing submodule $sm (shallow)"
    git -C "$root" submodule update --init --depth 1 "$sm"
  fi
done
