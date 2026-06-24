#pragma once
// Lightweight shim of envoy/common/random_generator.h. Same Random::RandomGenerator
// interface the real Envoy code calls; the harness supplies a concrete impl.
#include <cstdint>
#include <string>

#include "envoy/common/pure.h"

namespace Envoy {
namespace Random {

class RandomGenerator {
public:
  using result_type = uint64_t; // NOLINT(readability-identifier-naming)
  virtual ~RandomGenerator() = default;
  virtual result_type random() PURE;
  virtual std::string uuid() PURE;
  result_type operator()() { return random(); }
  static constexpr result_type min() { return 0; }
  static constexpr result_type max() { return UINT64_MAX; }
};
using RandomGeneratorPtr = std::unique_ptr<RandomGenerator>;

} // namespace Random
} // namespace Envoy
