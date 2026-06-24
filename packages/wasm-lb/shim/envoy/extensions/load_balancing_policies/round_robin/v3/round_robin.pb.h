#pragma once
// Proto-shaped stand-in for the round_robin policy config. round_robin_lb.h reads
// only the locality and slow-start sub-configs (via LoadBalancerConfigHelper); our
// harness leaves both unset so the EDF base takes its defaults (no zone-aware
// routing, no slow start), and the weighting comes from the real host weights.
// See ARCHITECTURE.md decision #2 and least_request.pb.h.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace round_robin {
namespace v3 {

class RoundRobin {
public:
  using SlowStartConfig = envoy::extensions::load_balancing_policies::common::v3::SlowStartConfig;
  using LocalityLbConfig = envoy::extensions::load_balancing_policies::common::v3::LocalityLbConfig;

  bool has_slow_start_config() const { return false; }
  const SlowStartConfig& slow_start_config() const { return slow_start_config_; }
  SlowStartConfig* mutable_slow_start_config() { return &slow_start_config_; }

  bool has_locality_lb_config() const { return false; }
  const LocalityLbConfig& locality_lb_config() const { return locality_lb_config_; }
  LocalityLbConfig* mutable_locality_lb_config() { return &locality_lb_config_; }

private:
  SlowStartConfig slow_start_config_;
  LocalityLbConfig locality_lb_config_;
};

} // namespace v3
} // namespace round_robin
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
