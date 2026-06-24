#pragma once
// Proto-shaped stub for the round_robin policy config. load_balancer_impl.h
// includes it; its fields are read by round_robin_lb.cc (not yet lifted), so the
// type alone suffices here. Expand when round_robin is lifted.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"
namespace envoy { namespace extensions { namespace load_balancing_policies { namespace round_robin { namespace v3 {
class RoundRobin {};
} } } } }
