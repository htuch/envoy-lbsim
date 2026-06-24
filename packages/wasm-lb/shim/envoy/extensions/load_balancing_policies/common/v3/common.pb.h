// Proto-shaped stand-ins for the common load-balancing-policy config messages
// the lifted maglev/ring_hash extension protos embed. Only the accessors the
// real .cc reads are provided; the values are unused in our harness (policy
// knobs arrive via @elbsim/config), so they return defaults. See
// ARCHITECTURE.md decision #2.
#pragma once

#include "absl/types/span.h"

#include "envoy/config/route/v3/route_components.pb.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace common {
namespace v3 {

using HashPolicyProto = envoy::config::route::v3::RouteAction::HashPolicy;

class ConsistentHashingLbConfig {
public:
  bool use_hostname_for_hashing() const { return false; }
  bool has_hash_balance_factor() const { return false; }
  const google::protobuf::UInt32Value& hash_balance_factor() const {
    static const google::protobuf::UInt32Value v;
    return v;
  }
  absl::Span<const HashPolicyProto* const> hash_policy() const { return {}; }
};

class LocalityLbConfig {
public:
  class LocalityWeightedLbConfig {};
};

} // namespace v3
} // namespace common
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
