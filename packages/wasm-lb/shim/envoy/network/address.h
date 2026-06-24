#pragma once
// Lightweight shim of envoy/network/address.h. The lifted LB only asks a host's
// address for its string form (a consistent-hash key / log line); the full
// Network::Address::Instance (sockaddr, ip/pipe variants, socket ops) is not
// needed in the harness.
#include <memory>
#include <string>

#include "absl/strings/string_view.h"

namespace Envoy {
namespace Network {
namespace Address {

class Instance {
public:
  explicit Instance(std::string addr) : addr_(std::move(addr)) {}
  virtual ~Instance() = default;
  const std::string& asString() const { return addr_; }
  absl::string_view asStringView() const { return addr_; }

private:
  std::string addr_;
};

using InstanceConstSharedPtr = std::shared_ptr<const Instance>;

} // namespace Address
} // namespace Network
} // namespace Envoy
