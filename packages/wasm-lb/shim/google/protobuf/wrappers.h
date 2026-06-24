#pragma once
// Minimal stand-ins for the google.protobuf wrapper messages the lifted Envoy
// LB config accessors return. We deliberately do NOT link the protobuf runtime
// (see ARCHITECTURE.md decision #2): config crosses the Wasm boundary as plain
// structs, and the few proto-shaped accessors the real .cc calls are satisfied
// by hand-written types exposing the same method names. Only value() / set_value()
// are exercised; everything else the generated code would provide is omitted.
#include <cstdint>

namespace google {
namespace protobuf {

class UInt64Value {
public:
  uint64_t value() const { return value_; }
  void set_value(uint64_t v) { value_ = v; }
  UInt64Value& operator=(const UInt64Value& other) = default;

private:
  uint64_t value_{0};
};

class UInt32Value {
public:
  uint32_t value() const { return value_; }
  void set_value(uint32_t v) { value_ = v; }

private:
  uint32_t value_{0};
};

} // namespace protobuf
} // namespace google
