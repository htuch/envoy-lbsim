#pragma once
// Shim of envoy/http/hash_policy.h: the HashPolicy interface for request-derived
// consistent-hash keys (header/cookie/query-param). The harness supplies the hash
// directly via LoadBalancerContext::computeHashKey(), so no policy is ever
// installed; this exists only so the lifted thread-aware code compiles.
#include <chrono>
#include <functional>
#include <string>
#include "absl/types/optional.h"
#include "absl/types/span.h"
#include "envoy/common/optref.h"
#include "envoy/common/pure.h"
#include "envoy/http/header_map.h"
#include "envoy/stream_info/stream_info.h"
namespace Envoy {
namespace Http {
struct CookieAttribute {
  std::string name_;
  std::string value_;
};
using AddCookieCallback = std::function<std::string(
    absl::string_view, absl::string_view, std::chrono::seconds, absl::Span<const CookieAttribute>)>;
class HashPolicy {
public:
  virtual ~HashPolicy() = default;
  virtual absl::optional<uint64_t> generateHash(OptRef<const RequestHeaderMap> headers,
                                                OptRef<const StreamInfo::StreamInfo> info,
                                                AddCookieCallback add_cookie = nullptr) const PURE;
};
} // namespace Http
} // namespace Envoy
