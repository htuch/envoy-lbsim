#pragma once
// Shim of source/common/runtime/runtime_features.h. maglev_lb.cc includes this
// header but, in v1.36.0, does not branch on any runtime feature flag at the
// points we compile. Provide an empty stand-in plus a permissive
// runtimeFeatureEnabled() in case a transitively-included macro references it.
#include "absl/strings/string_view.h"

namespace Envoy {
namespace Runtime {

inline bool runtimeFeatureEnabled(absl::string_view) { return true; }

} // namespace Runtime
} // namespace Envoy
