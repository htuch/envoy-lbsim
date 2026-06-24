// Smoke brick for the Wasm LB build.
//
// Compiles the REAL, UNMODIFIED Envoy `source/common/upstream/edf_scheduler.h`
// (from the third_party/envoy submodule) in place, against the lightweight
// `shim/` interface headers (include-shadowing: -Ishim before -Ithird_party/envoy).
// EDF is abseil-free, so this links with ZERO third-party deps -- it is the
// first proof that the shim + Emscripten + Embind toolchain works end to end.
//
// Track A grows this into the full LB ABI (Maglev, ring_hash, round_robin,
// least_request, random) declared in `@elbsim/protocol` (wasm-abi.ts), reusing
// the same shim approach and the abseil source subset documented in
// docs/ARCHITECTURE.md.

#include <cstdint>
#include <memory>
#include <vector>

#include <emscripten/bind.h>

#include "source/common/upstream/edf_scheduler.h" // REAL Envoy, untouched

namespace {

struct Host {
  uint32_t id;
  double weight;
};

// Build a weighted EDF schedule and return the realized pick counts per host.
// With enough picks, count[i] / total approaches weight[i] / sum(weight) --
// exactly Envoy's weighted-round-robin behavior.
std::vector<int> edfPickCounts(const std::vector<double>& weights, int picks) {
  Envoy::Upstream::EdfScheduler<Host> edf;
  std::vector<std::shared_ptr<Host>> hosts;
  hosts.reserve(weights.size());
  for (uint32_t i = 0; i < weights.size(); ++i) {
    auto h = std::make_shared<Host>(Host{i, weights[i]});
    hosts.push_back(h);
    edf.add(h->weight, h);
  }

  std::vector<int> counts(weights.size(), 0);
  const auto weight_fn = [](const Host& h) { return h.weight; };
  for (int p = 0; p < picks; ++p) {
    auto picked = edf.pickAndAdd(weight_fn);
    if (picked) {
      counts[picked->id]++;
    }
  }
  return counts;
}

} // namespace

EMSCRIPTEN_BINDINGS(elbsim_wasm_lb) {
  emscripten::register_vector<double>("VectorDouble");
  emscripten::register_vector<int>("VectorInt");
  emscripten::function("edfPickCounts", &edfPickCounts);
}
