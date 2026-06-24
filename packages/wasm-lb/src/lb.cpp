// Real Envoy LB compiled to Wasm, exposed over the Embind ABI declared in
// @elbsim/protocol (wasm-abi.ts). This translation unit instantiates Envoy's
// actual load-balancer data structures -- here the Maglev consistent-hash table
// from the unmodified source/extensions/load_balancing_policies/maglev/maglev_lb.cc
// -- and drives them per request. Priority/health/locality/panic resolution is
// the kernel's job (see ARCHITECTURE.md); the kernel hands us an already-resolved
// set of healthy backends as flat arrays, so the ABI stays small and protobuf-free.
//
// The shim/ headers shadow Envoy's heavy interface headers (include order
// -Ishim before -Ithird_party/envoy), letting the real algorithm compile in
// place. See packages/wasm-lb/shim and docs/ARCHITECTURE.md.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/bind.h>

#include "source/extensions/load_balancing_policies/maglev/maglev_lb.h" // REAL Envoy

namespace EU = Envoy::Upstream;

namespace {

// One Envoy replica's load balancer. Subclasses wrap a specific real policy.
// The kernel creates one per replica and drives it via the methods below.
class LbInstance {
public:
  virtual ~LbInstance() = default;

  // Rebuild internal structures for a resolved host set. backends[i] is the
  // kernel's BackendId for host i; weights[i] its load-balancing weight. Only
  // hosts the kernel considers eligible are passed (health/locality already
  // applied TS-side), mirroring the host set Envoy's base would hand the policy.
  virtual void updateHosts(const std::vector<int>& backends,
                           const std::vector<double>& weights) = 0;

  // Choose a backend for a request keyed by hash; returns the BackendId or -1.
  virtual int chooseHost(double hash) = 0;

  // Serialize the live structure for the inspector. Layout is policy-specific and
  // assembled into @elbsim/protocol's LbStructure on the TS side.
  virtual emscripten::val inspect() = 0;
};

// Maglev: Envoy's real consistent-hash table (OriginalMaglevTable). We construct
// it directly from the normalized host-weight vector, exactly as Envoy's
// ThreadAwareLoadBalancerBase::refresh would, and read picks/slots through its
// public chooseHost(). The hash identity for a host is the decimal string of its
// BackendId (our sim's stable host address surrogate).
class MaglevLb : public LbInstance {
public:
  MaglevLb(uint32_t table_size, bool use_hostname)
      : table_size_(table_size), use_hostname_(use_hostname) {}

  void updateHosts(const std::vector<int>& backends,
                   const std::vector<double>& weights) override {
    table_.reset();
    if (backends.empty()) {
      return;
    }
    double sum = 0.0;
    for (double w : weights) {
      sum += w;
    }
    // Normalize to sum=1 (Envoy's NormalizedHostWeightVector convention); the
    // table only depends on relative weights, so this matches the oracle.
    EU::NormalizedHostWeightVector normalized;
    normalized.reserve(backends.size());
    double max_normalized = 0.0;
    for (size_t i = 0; i < backends.size(); ++i) {
      const double nw = sum > 0.0 ? weights[i] / sum : 1.0 / backends.size();
      max_normalized = std::max(max_normalized, nw);
      normalized.emplace_back(
          std::make_shared<const EU::Host>(static_cast<uint32_t>(backends[i]),
                                           static_cast<uint32_t>(weights[i]),
                                           std::to_string(backends[i])),
          nw);
    }
    table_ = std::make_shared<EU::OriginalMaglevTable>(normalized, max_normalized, table_size_,
                                                       use_hostname_, stats_);
  }

  int chooseHost(double hash) override {
    if (!table_) {
      return -1;
    }
    const auto resp = table_->chooseHost(static_cast<uint64_t>(hash), 0);
    return resp.host ? static_cast<int>(resp.host->backend()) : -1;
  }

  emscripten::val inspect() override {
    emscripten::val out = emscripten::val::object();
    out.set("kind", std::string("maglev"));
    out.set("tableSize", static_cast<double>(table_size_));
    // Per-slot backend id. chooseHost(slot, 0) returns table_[slot] because
    // slot < table_size_ so (slot % table_size_) == slot and attempt 0 leaves
    // the hash untouched -- the public interface fully reveals the table.
    emscripten::val table = emscripten::val::array();
    for (uint32_t slot = 0; slot < table_size_; ++slot) {
      table.call<void>("push", chooseHost(static_cast<double>(slot)));
    }
    out.set("table", table);
    return out;
  }

private:
  const uint32_t table_size_;
  const bool use_hostname_;
  EU::MaglevLoadBalancerStats stats_{};
  EU::MaglevTableSharedPtr table_;
};

// Factory dispatched by policy kind on the TS side. Only maglev is lifted so far;
// the remaining policies fall back to the kernel's mock until their lifts land.
MaglevLb* createMaglevLb(uint32_t table_size, bool use_hostname) {
  return new MaglevLb(table_size, use_hostname);
}

} // namespace

EMSCRIPTEN_BINDINGS(elbsim_wasm_lb) {
  emscripten::register_vector<int>("VectorInt");
  emscripten::register_vector<double>("VectorDouble");

  emscripten::class_<LbInstance>("LbInstance")
      .function("updateHosts", &LbInstance::updateHosts)
      .function("chooseHost", &LbInstance::chooseHost)
      .function("inspect", &LbInstance::inspect);

  emscripten::class_<MaglevLb, emscripten::base<LbInstance>>("MaglevLb");

  emscripten::function("createMaglevLb", &createMaglevLb, emscripten::allow_raw_pointers());
}
