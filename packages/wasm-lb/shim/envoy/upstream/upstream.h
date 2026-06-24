#pragma once
// Lightweight shim of envoy/upstream/upstream.h. The real header is the large
// Host/HostSet/ClusterInfo interface; the lifted LB algorithms touch only a tiny
// slice of Host (its hash identity and weight). Our Host is a concrete value
// carrying exactly what the harness needs: the backend id the kernel assigned
// (so a chosen host maps back across the ABI), the load-balancing weight, and a
// hash key exposed as both hostname() and address()->asString() so the lifted
// hashKey() resolves to a stable string. Health/locality/priority live in the
// kernel (see ARCHITECTURE.md), not here.
#include <cstdint>
#include <memory>
#include <string>

#include "absl/strings/string_view.h"

// Pulls the little-endian helpers BitArray needs (maglev_lb.h includes
// bit_array.h before the thread-aware base); our platform.h shadow trims the
// real header's networking includes.
#include "envoy/common/platform.h"

namespace Envoy {
namespace Upstream {

namespace Address {
// Minimal Network::Address::Instance stand-in: the lifted code only asks an
// address for its string form to use as a consistent-hash key.
class Instance {
public:
  explicit Instance(std::string addr) : addr_(std::move(addr)) {}
  const std::string& asString() const { return addr_; }

private:
  std::string addr_;
};
using InstanceConstSharedPtr = std::shared_ptr<const Instance>;
} // namespace Address

class Host {
public:
  Host(uint32_t backend, uint32_t weight, std::string hash_key)
      : backend_(backend), weight_(weight), hostname_(hash_key),
        address_(std::make_shared<const Address::Instance>(std::move(hash_key))) {}

  // The id the kernel assigned this backend; how a picked host crosses the ABI.
  uint32_t backend() const { return backend_; }

  uint32_t weight() const { return weight_; }
  const std::string& hostname() const { return hostname_; }
  Address::InstanceConstSharedPtr address() const { return address_; }

private:
  const uint32_t backend_;
  const uint32_t weight_;
  const std::string hostname_;
  const Address::InstanceConstSharedPtr address_;
};

using HostConstSharedPtr = std::shared_ptr<const Host>;
using HostSharedPtr = std::shared_ptr<Host>;
using HostVector = std::vector<HostSharedPtr>;

} // namespace Upstream
} // namespace Envoy
