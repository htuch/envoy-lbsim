# Wasm LB build. Deliberately NOT Bazel and NOT CMake (cmake is not required for
# this build): a hand-written Makefile drives `em++` directly, exactly as the
# lb_core feasibility study proved. The include order makes the lightweight
# `shim/` interface headers shadow Envoy's heavy ones, while the REAL Envoy
# implementation headers under the submodule compile untouched.
#
# Prereqs: an activated Emscripten SDK (em++ on PATH). `make` here assumes that;
# use the package `build`/`test:wasm` scripts (scripts/with-emsdk.sh) to source
# the SDK automatically.

EMXX    ?= em++
ENVOY   ?= ../../third_party/envoy
ABSL    ?= ../../third_party/abseil-cpp
BUILD   ?= build

# Curated abseil source subset (see absl_wasm_sources.txt for the why). Most
# real Envoy LB code pulls in absl::flat_hash_map, which cascades into abseil
# synchronization/time/debugging; these .cc compile that closure to Wasm. EDF
# alone is abseil-free, so the smoke brick below does not link it. The
# maglev/ring_hash and EDF-base policy targets (Track A) link $(ABSL_WASM_SRC).
ABSL_WASM_SRC := $(addprefix $(ABSL)/,$(shell grep -vE '^\#|^[[:space:]]*$$' absl_wasm_sources.txt))

# Single-threaded build -> no SharedArrayBuffer / COOP-COEP needed for the module
# itself (the app uses SAB for telemetry ring buffers, a separate concern).
EMFLAGS := -std=c++20 -O2 -lembind \
           -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
           -sALLOW_MEMORY_GROWTH=1 -sEXPORT_NAME=createLbModule

INCLUDES := -Ishim -I$(ENVOY)

.PHONY: build clean
build: $(BUILD)/edf_smoke.mjs
$(BUILD)/edf_smoke.mjs: src/edf_smoke.cpp $(wildcard shim/**/*.h)
	@mkdir -p $(BUILD)
	$(EMXX) $(EMFLAGS) $(INCLUDES) src/edf_smoke.cpp -o $@
	@echo "built $@"

clean:
	rm -rf $(BUILD)
