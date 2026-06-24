#pragma once
// Proto-shaped stand-in for the random policy config. random_lb.h reads only the
// locality sub-config (via LoadBalancerConfigHelper); our harness leaves it unset
// so the zone-aware base takes its defaults. See round_robin.pb.h.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace random {
namespace v3 {

class Random {
public:
  using LocalityLbConfig = envoy::extensions::load_balancing_policies::common::v3::LocalityLbConfig;

  bool has_locality_lb_config() const { return false; }
  const LocalityLbConfig& locality_lb_config() const { return locality_lb_config_; }
  LocalityLbConfig* mutable_locality_lb_config() { return &locality_lb_config_; }

private:
  LocalityLbConfig locality_lb_config_;
};

} // namespace v3
} // namespace random
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
