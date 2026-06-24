#pragma once
// Shim of envoy/upstream/scheduler.h -- the real interface is already a pure
// generic template, so this is a faithful copy (it is what the real EDF/WRSQ
// schedulers implement).
// The real EDF/WRSQ headers rely on these via transitive Envoy includes; provide
// them here so the lifted headers stay byte-for-byte untouched.
#include <algorithm>
#include <cstdint>
#include <functional>
#include <list>
#include <memory>
#include <numeric>
#include <vector>

namespace Envoy {
namespace Upstream {

template <class C> class Scheduler {
public:
  virtual ~Scheduler() = default;
  virtual std::shared_ptr<C> peekAgain(std::function<double(const C&)> calculate_weight) = 0;
  virtual std::shared_ptr<C> pickAndAdd(std::function<double(const C&)> calculate_weight) = 0;
  virtual void add(double weight, std::shared_ptr<C> entry) = 0;
  virtual bool empty() const = 0;
};

} // namespace Upstream
} // namespace Envoy
