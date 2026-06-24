#pragma once
// Shim of source/common/runtime/runtime_features.h. maglev_lb.cc includes this
// header but, in v1.36.0, does not branch on any runtime feature flag at the
// points we compile. Provide an empty stand-in plus a permissive
// runtimeFeatureEnabled() in case a transitively-included macro references it.
//
// It also serves as maglev_lb.cc's injection point for three leaf utilities the
// real maglev code uses (HashUtil::xxHash64, Primes::isPrime, EnvoyException):
// upstream they arrive transitively through headers we now shadow, so we pull the
// real/shim versions here, where maglev_lb.cc includes us before first use.
#include "absl/strings/string_view.h"

#include "envoy/common/exception.h"        // shim: EnvoyException
#include "source/common/common/hash.h"     // REAL: HashUtil::xxHash64
#include "source/common/common/utility.h"  // shim: Primes::isPrime

namespace Envoy {
namespace Runtime {

inline bool runtimeFeatureEnabled(absl::string_view) { return true; }

} // namespace Runtime
} // namespace Envoy
