#!/usr/bin/env bash
# Activate the Emscripten SDK, then exec the given command. The SDK location is
# taken from $EMSDK_ENV (path to emsdk_env.sh); it defaults to ~/emsdk which is
# where this environment installs it. CI sets up emsdk via the mymindstorm/setup-emsdk
# action, which puts em++ on PATH directly, so this script becomes a no-op there.
set -euo pipefail

EMSDK_ENV="${EMSDK_ENV:-$HOME/emsdk/emsdk_env.sh}"

if ! command -v em++ >/dev/null 2>&1; then
  if [ -f "$EMSDK_ENV" ]; then
    # shellcheck disable=SC1090
    source "$EMSDK_ENV" >/dev/null 2>&1
  else
    echo "error: em++ not on PATH and no emsdk_env.sh at $EMSDK_ENV" >&2
    echo "       install the Emscripten SDK or set EMSDK_ENV to its emsdk_env.sh" >&2
    exit 127
  fi
fi

exec "$@"
