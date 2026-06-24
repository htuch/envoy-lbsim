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

# -Ishim FIRST so the lightweight interface headers shadow Envoy's heavy ones.
# -Ivendor carries third-party headers Envoy expects on the include path
# (xxhash, header-only via -DXXH_INLINE_ALL) so HashUtil::xxHash64 is bit-faithful.
INCLUDES := -Ishim -I$(ENVOY) -I$(ABSL) -Ivendor
DEFINES  := -DXXH_INLINE_ALL

# The real Envoy LB base + policy implementations compiled in place (untouched).
# The base (load_balancer_impl + thread_aware + locality_wrr) is lifted, not
# shimmed, so Envoy's real priority/panic/locality/weight logic runs; the shim/
# headers shadow only its leaf interfaces. See docs/STATUS.md Track A.
LB_DIR   := $(ENVOY)/source/extensions/load_balancing_policies
ENVOY_LB := $(LB_DIR)/common/load_balancer_impl.cc \
            $(LB_DIR)/common/thread_aware_lb_impl.cc \
            $(LB_DIR)/common/locality_wrr.cc \
            $(LB_DIR)/maglev/maglev_lb.cc

SHIM_HDRS := $(shell find shim -name '*.h') vendor/xxhash.h

.PHONY: build smoke clean
# Default: the real LB module (Embind ABI from @elbsim/protocol).
build: $(BUILD)/lb.mjs
$(BUILD)/lb.mjs: src/lb.cpp $(ENVOY_LB) $(SHIM_HDRS) absl_wasm_sources.txt
	@mkdir -p $(BUILD)
	$(EMXX) $(EMFLAGS) $(INCLUDES) $(DEFINES) -w src/lb.cpp $(ENVOY_LB) $(ABSL_WASM_SRC) -o $@
	@echo "built $@"

# The original EDF smoke brick (abseil-free); kept as the minimal toolchain proof.
smoke: $(BUILD)/edf_smoke.mjs
$(BUILD)/edf_smoke.mjs: src/edf_smoke.cpp $(wildcard shim/**/*.h)
	@mkdir -p $(BUILD)
	$(EMXX) $(EMFLAGS) -Ishim -I$(ENVOY) src/edf_smoke.cpp -o $@
	@echo "built $@"

clean:
	rm -rf $(BUILD)
