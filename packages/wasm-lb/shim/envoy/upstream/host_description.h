#pragma once
// Faithful-minimal shadow of envoy/upstream/host_description.h.
//
// The real header is the wide Host identity/stats/health-check interface and
// drags in network, transport-socket, outlier-detection, resource-manager, and
// ORCA proto headers. The lifted LB base touches only a thin slice: a host's
// address/hostname (hash identity + logs), locality (zone-aware routing),
// metadata (hash-key path, shimmed out), live active-request gauge (least_request
// weight), and its cluster's traffic stats. We declare exactly that surface; the
// concrete implementation lives in src/lb.cpp, built from the resolved host set.
#include <memory>
#include <string>

#include "envoy/common/pure.h"
#include "envoy/config/core/v3/base.pb.h"
#include "envoy/network/address.h"

namespace Envoy {

namespace Stats {
// Primitive (lock-free, value-typed) stats, as Envoy uses for per-host counters.
// The lifted code reads the active-request gauge to weight least_request.
class PrimitiveGauge {
public:
  uint64_t value() const { return value_; }
  void inc() { ++value_; }
  void dec() { --value_; }
  void add(uint64_t amount) { value_ += amount; }
  void sub(uint64_t amount) { value_ -= amount; }
  void set(uint64_t value) { value_ = value; }

private:
  uint64_t value_{0};
};

class PrimitiveCounter {
public:
  uint64_t value() const { return value_; }
  void inc() { ++value_; }
  void add(uint64_t amount) { value_ += amount; }

private:
  uint64_t value_{0};
};
} // namespace Stats

namespace Upstream {

using MetadataConstSharedPtr = std::shared_ptr<const envoy::config::core::v3::Metadata>;

class ClusterInfo;

/** Per-host stats. Only the active-request gauge is read by the lifted LB. */
struct HostStats {
  Stats::PrimitiveGauge rq_active_;
  Stats::PrimitiveGauge cx_active_;
  Stats::PrimitiveCounter rq_total_;
};

/**
 * Host identity surface the lifted LB consumes. Concrete impl in src/lb.cpp.
 */
class HostDescription {
public:
  virtual ~HostDescription() = default;
  virtual const std::string& hostname() const PURE;
  virtual Network::Address::InstanceConstSharedPtr address() const PURE;
  virtual const envoy::config::core::v3::Locality& locality() const PURE;
  virtual MetadataConstSharedPtr metadata() const PURE;
  virtual const ClusterInfo& cluster() const PURE;
  virtual HostStats& stats() const PURE;
};

} // namespace Upstream
} // namespace Envoy
