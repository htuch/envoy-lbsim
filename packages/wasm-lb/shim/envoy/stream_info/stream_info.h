#pragma once
// Shim of envoy/stream_info/stream_info.h. The lifted cookie hashing path reads
// the downstream connection's addresses off the stream info; the harness has no
// real request, that path is never taken at runtime, and the type only needs to
// compile.
#include "envoy/network/address.h"
namespace Envoy {
namespace StreamInfo {
class DownstreamAddressProvider {
public:
  Network::Address::InstanceConstSharedPtr remoteAddress() const { return nullptr; }
  Network::Address::InstanceConstSharedPtr localAddress() const { return nullptr; }
};
class StreamInfo {
public:
  virtual ~StreamInfo() = default;
  const DownstreamAddressProvider& downstreamAddressProvider() const { return provider_; }
private:
  DownstreamAddressProvider provider_;
};
} // namespace StreamInfo
} // namespace Envoy
