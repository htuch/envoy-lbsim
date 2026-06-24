#pragma once
// Shim of source/common/http/hash_policy.h. HashPolicyImpl reads route hash
// policies (header/cookie/query-param) to derive a request hash. The harness
// installs no hash policy (the kernel passes the hash via computeHashKey), so
// create() yields an empty policy and generateHash() is never called at runtime.
#include <memory>
#include <vector>
#include "absl/status/statusor.h"
#include "absl/types/optional.h"
#include "absl/types/span.h"
#include "envoy/config/route/v3/route_components.pb.h"
#include "envoy/http/hash_policy.h"
namespace Envoy {
namespace Regex {
class Engine;
}
namespace Http {
class HashPolicyImpl : public HashPolicy {
public:
  static absl::StatusOr<std::unique_ptr<HashPolicyImpl>>
  create(absl::Span<const envoy::config::route::v3::RouteAction::HashPolicy* const> /*hash_policy*/,
         Regex::Engine& /*regex_engine*/) {
    return std::unique_ptr<HashPolicyImpl>(new HashPolicyImpl());
  }
  absl::optional<uint64_t> generateHash(OptRef<const RequestHeaderMap>,
                                        OptRef<const StreamInfo::StreamInfo>,
                                        AddCookieCallback = nullptr) const override {
    return absl::nullopt;
  }
};
} // namespace Http
} // namespace Envoy
