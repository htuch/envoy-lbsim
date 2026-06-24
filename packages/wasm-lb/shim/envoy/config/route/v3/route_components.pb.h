#pragma once
// Proto-shaped stand-in for the one route message the lifted hash-LB config
// references by type: RouteAction::HashPolicy. The maglev/ring_hash config only
// passes a (always-empty, in our harness) span of these to the unused
// TypedHashLbConfigBase ctor, so an opaque declaration is all the real .cc needs
// to compile. No fields are accessed.
namespace envoy {
namespace config {
namespace route {
namespace v3 {

class RouteAction {
public:
  class HashPolicy {};
};

} // namespace v3
} // namespace route
} // namespace config
} // namespace envoy
