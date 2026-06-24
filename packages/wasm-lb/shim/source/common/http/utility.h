#pragma once
// Shim of source/common/http/utility.h, reduced to the Set-Cookie formatter the
// (compile-only) cookie hashing path calls.
#include <chrono>
#include <string>
#include "absl/strings/string_view.h"
#include "absl/types/span.h"
#include "envoy/http/hash_policy.h"
namespace Envoy {
namespace Http {
class Utility {
public:
  static std::string makeSetCookieValue(absl::string_view name, absl::string_view value,
                                        absl::string_view /*path*/, std::chrono::seconds /*ttl*/,
                                        bool /*httponly*/,
                                        absl::Span<const CookieAttribute> /*attributes*/) {
    return std::string(name) + "=" + std::string(value);
  }
};
} // namespace Http
} // namespace Envoy
