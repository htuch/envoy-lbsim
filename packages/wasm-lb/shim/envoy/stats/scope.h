#pragma once
// Shim of envoy/stats/scope.h reduced to the surface the lifted LB code touches:
// a Gauge that records a value, and a Scope that hands out child scopes. The
// real Envoy stats subsystem (symbol tables, allocators, flushing) is irrelevant
// in the harness; the LB only set()s a couple of gauges (max/min entries per
// host) which we keep live so the real construction code runs unchanged.
#include <cstdint>
#include <memory>
#include <string>

#include "envoy/common/pure.h" // PURE; ring_hash_lb.cc reaches scope.h before it transitively

namespace Envoy {
namespace Stats {

class Gauge {
public:
  void set(uint64_t value) { value_ = value; }
  uint64_t value() const { return value_; }

private:
  uint64_t value_{0};
};

class Scope;
using ScopeSharedPtr = std::shared_ptr<Scope>;

class Scope {
public:
  virtual ~Scope() = default;
  virtual ScopeSharedPtr createScope(const std::string& name) PURE;
};

} // namespace Stats
} // namespace Envoy
