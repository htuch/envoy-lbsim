#pragma once
// Faithful-minimal shadow of envoy/upstream/load_balancer.h.
//
// The real header drags in router, stream_info, transport_socket, and ORCA proto
// headers via the rich LoadBalancerContext. The lifted base needs the *shapes* of
// these interfaces (LoadBalancer, LoadBalancerContext, the factory/params, the
// thread-aware interface) but, in the harness, almost none of the context
// callbacks fire: the kernel supplies the hash via computeHashKey() and there are
// no real HTTP requests. So heavy collaborators are forward-declared and the
// per-request context defaults to "no opinion".
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/types/optional.h"

#include "envoy/common/optref.h"
#include "envoy/common/pure.h"
#include "envoy/upstream/types.h"
#include "envoy/upstream/upstream.h"

#include "source/common/common/logger.h"

// Forward declarations for collaborators named only in signatures we do not drive.
namespace Envoy {
namespace Network {
class Connection;
class Socket {
public:
  class Options;
  using OptionsSharedPtr = std::shared_ptr<Options>;
};
class TransportSocketOptions;
using TransportSocketOptionsConstSharedPtr = std::shared_ptr<const TransportSocketOptions>;
} // namespace Network
namespace Router {
class MetadataMatchCriteria;
} // namespace Router
namespace StreamInfo {
class StreamInfo;
} // namespace StreamInfo
namespace Http {
class RequestHeaderMap;
class ResponseHeaderMap;
namespace ConnectionPool {
class ConnectionLifetimeCallbacks;
} // namespace ConnectionPool
} // namespace Http
namespace ConnectionPool {
class Instance;
} // namespace ConnectionPool

namespace Upstream {

// Subset of the retry-priority interface named by determinePriorityLoad.
class RetryPriority {
public:
  using PriorityMappingFunc =
      std::function<absl::optional<uint32_t>(const Upstream::HostDescription&)>;
  // The default mapping: a host maps to no priority override.
  static absl::optional<uint32_t> defaultPriorityMapping(const Upstream::HostDescription&) {
    return absl::nullopt;
  }
};

class AsyncHostSelectionHandle {
public:
  virtual ~AsyncHostSelectionHandle() = default;
  virtual void cancel() PURE;
};

struct HostSelectionResponse {
  HostSelectionResponse(HostConstSharedPtr host,
                        std::unique_ptr<AsyncHostSelectionHandle> cancelable = nullptr)
      : host(std::move(host)), cancelable(std::move(cancelable)) {}
  HostSelectionResponse(HostConstSharedPtr host, std::string details)
      : host(std::move(host)), details(std::move(details)) {}
  HostConstSharedPtr host;
  std::string details;
  std::unique_ptr<AsyncHostSelectionHandle> cancelable;
};

class LoadBalancerContext {
public:
  using OverrideHost = std::pair<absl::string_view, bool>;
  virtual ~LoadBalancerContext() = default;
  virtual absl::optional<uint64_t> computeHashKey() PURE;
  virtual const Router::MetadataMatchCriteria* metadataMatchCriteria() PURE;
  virtual const Network::Connection* downstreamConnection() const PURE;
  virtual StreamInfo::StreamInfo* requestStreamInfo() const PURE;
  virtual const Http::RequestHeaderMap* downstreamHeaders() const PURE;
  virtual const HealthyAndDegradedLoad&
  determinePriorityLoad(const PrioritySet& priority_set,
                        const HealthyAndDegradedLoad& original_priority_load,
                        const RetryPriority::PriorityMappingFunc& priority_mapping_func) PURE;
  virtual bool shouldSelectAnotherHost(const Host& host) PURE;
  virtual uint32_t hostSelectionRetryCount() const PURE;
  virtual Network::Socket::OptionsSharedPtr upstreamSocketOptions() const PURE;
  virtual Network::TransportSocketOptionsConstSharedPtr upstreamTransportSocketOptions() const PURE;
  virtual absl::optional<OverrideHost> overrideHostToSelect() const PURE;
  virtual void onAsyncHostSelection(HostConstSharedPtr&& host, std::string&& details) PURE;
  virtual void setHeadersModifier(std::function<void(Http::ResponseHeaderMap&)> modifier) PURE;
};

struct SelectedPoolAndConnection {
  Envoy::ConnectionPool::Instance& pool_;
  const Network::Connection& connection_;
};

class LoadBalancer {
public:
  virtual ~LoadBalancer() = default;
  static HostConstSharedPtr onlyAllowSynchronousHostSelection(HostSelectionResponse host_selection) {
    if (host_selection.cancelable) {
      host_selection.cancelable->cancel();
    }
    return std::move(host_selection.host);
  }
  virtual HostSelectionResponse chooseHost(LoadBalancerContext* context) PURE;
  virtual HostConstSharedPtr peekAnotherHost(LoadBalancerContext* context) PURE;
  virtual OptRef<Envoy::Http::ConnectionPool::ConnectionLifetimeCallbacks> lifetimeCallbacks() PURE;
  virtual absl::optional<SelectedPoolAndConnection>
  selectExistingConnection(LoadBalancerContext* context, const Host& host,
                           std::vector<uint8_t>& hash_key) PURE;
};
using LoadBalancerPtr = std::unique_ptr<LoadBalancer>;

struct LoadBalancerParams {
  const PrioritySet& priority_set;
  const PrioritySet* local_priority_set{};
};

class LoadBalancerFactory {
public:
  virtual ~LoadBalancerFactory() = default;
  virtual LoadBalancerPtr create(LoadBalancerParams params) PURE;
  virtual bool recreateOnHostChange() const { return true; }
};
using LoadBalancerFactorySharedPtr = std::shared_ptr<LoadBalancerFactory>;

class ThreadAwareLoadBalancer {
public:
  virtual ~ThreadAwareLoadBalancer() = default;
  virtual LoadBalancerFactorySharedPtr factory() PURE;
  virtual absl::Status initialize() PURE;
};

// Base for typed LB configs. The real one validates endpoints against the
// priority state; the harness does not call it, but the virtual must exist so
// TypedHashLbConfigBase can override it.
class LoadBalancerConfig {
public:
  virtual ~LoadBalancerConfig() = default;
  virtual absl::Status validateEndpoints(const PriorityState& priorities) const {
    (void)priorities;
    return absl::OkStatus();
  }
};
using LoadBalancerConfigPtr = std::unique_ptr<LoadBalancerConfig>;

} // namespace Upstream
} // namespace Envoy
