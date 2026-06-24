#pragma once
// Shim of envoy/common/callback.h. The LB base registers priority/member update
// callbacks on the PrioritySet and holds the returned handle to unregister on
// destruction. In the harness we rebuild the whole LB on each host-set update
// (see src/lb.cpp), so the handle only needs to be a valid RAII no-op.
#include <functional>
#include <memory>

namespace Envoy {
namespace Common {

class CallbackHandle {
public:
  virtual ~CallbackHandle() = default;
};

using CallbackHandlePtr = std::unique_ptr<CallbackHandle>;

} // namespace Common
} // namespace Envoy
