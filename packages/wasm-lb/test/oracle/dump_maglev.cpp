// Golden-fixture generator for the maglev lift.
//
// Emits the slot -> BackendId table produced by the lb_core extract-track
// MaglevTable (the independent re-implementation that serves as our oracle; see
// docs/STATUS.md Track A) for a fixed {backendId, weight} input, as JSON on
// stdout. The committed fixture test/maglev_golden.json is this program's output;
// the Vitest golden test asserts the real-Envoy Wasm table matches it slot for
// slot, proving the lift is bit-faithful to the algorithm.
//
// This is a dev-time tool, not built in CI. Regenerate with:
//   c++ -std=c++17 -O2 -I"$LBCORE/include" \
//       test/oracle/dump_maglev.cpp "$LBCORE/src/maglev_table.cpp" -o /tmp/dump_maglev
//   /tmp/dump_maglev > test/maglev_golden.json
// where $LBCORE is a checkout of the lb_core feasibility study. The host hash key
// is the decimal BackendId string, matching src/lb.cpp's host address surrogate.
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "lbcore/maglev_table.h"

int main() {
  // Fixed scenario: skewed weights over a small prime table for an exact,
  // human-reviewable golden. Keep in sync with the Vitest test's inputs.
  const std::vector<int> backends = {10, 20, 30, 40, 50};
  const std::vector<double> weights = {1, 1, 2, 3, 5};
  const uint64_t table_size = 1021;

  // Normalize weights to sum=1 exactly as src/lb.cpp does before handing them to
  // the table builder. Envoy's ThreadAwareLoadBalancerBase normalizes the host
  // weights this way; feeding the oracle the same normalized doubles makes the
  // two implementations bit-identical (raw vs normalized weights are algebraically
  // equal but accumulate float rounding differently across the build iterations).
  double sum = 0.0;
  for (double w : weights) {
    sum += w;
  }
  std::vector<lbcore::HostWeight> hosts;
  for (size_t i = 0; i < backends.size(); ++i) {
    const double nw = sum > 0.0 ? weights[i] / sum : 1.0 / backends.size();
    hosts.push_back({std::to_string(backends[i]), nw});
  }

  lbcore::MaglevTable table(hosts, table_size);
  const auto& slots = table.table();

  printf("{\n");
  printf("  \"_provenance\": \"lb_core extract-track MaglevTable oracle\",\n");
  printf("  \"tableSize\": %llu,\n", (unsigned long long)table_size);
  printf("  \"backends\": [10, 20, 30, 40, 50],\n");
  printf("  \"weights\": [1, 1, 2, 3, 5],\n");
  printf("  \"table\": [");
  for (size_t i = 0; i < slots.size(); ++i) {
    if (i > 0) {
      printf(",");
    }
    printf("%d", backends[slots[i]]);
  }
  printf("]\n}\n");
  return 0;
}
