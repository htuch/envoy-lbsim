#pragma once
// Shim of envoy/common/regex.h. A regex Engine is named only in the typed
// hash-LB config constructors (used for matching metadata hash policies), which
// the harness never instantiates. An opaque type satisfies the signatures.
namespace Envoy {
namespace Regex {

class Engine {
public:
  virtual ~Engine() = default;
};

} // namespace Regex
} // namespace Envoy
