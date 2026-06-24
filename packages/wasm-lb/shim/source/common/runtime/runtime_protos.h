#pragma once
// Shim of source/common/runtime/runtime_protos.h. These helpers wrap a config
// value that operators could override via the Runtime layer. The sim has no such
// layer, so each returns its proto default. Only Runtime::Double is referenced by
// the lifted base (slow-start aggression), and slow start is not exercised.
#include <cstdint>
#include <string>

#include "envoy/config/core/v3/base.pb.h"
#include "envoy/runtime/runtime.h"

namespace Envoy {
namespace Runtime {

class Double {
public:
  Double(const envoy::config::core::v3::RuntimeDouble& proto, Runtime::Loader& runtime)
      : runtime_key_(proto.runtime_key()), default_value_(proto.default_value()), runtime_(runtime) {}
  double value() const { return runtime_.snapshot().getDouble(runtime_key_, default_value_); }

private:
  const std::string runtime_key_;
  const double default_value_;
  Runtime::Loader& runtime_;
};

} // namespace Runtime
} // namespace Envoy
