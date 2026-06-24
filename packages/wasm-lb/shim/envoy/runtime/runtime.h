#pragma once
// Shim of envoy/runtime/runtime.h. Runtime::Loader gates feature flags at
// runtime in Envoy; the lifted LB only names it in a constructor signature (the
// thread-aware wrapper we never instantiate). An opaque type is enough.
namespace Envoy {
namespace Runtime {

class Loader {
public:
  virtual ~Loader() = default;
};

} // namespace Runtime
} // namespace Envoy
