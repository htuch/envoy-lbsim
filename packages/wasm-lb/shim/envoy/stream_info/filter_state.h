#pragma once
// Shim: the lifted hash-policy header includes filter_state.h but the harness
// never exercises filter-state-based hashing.
namespace Envoy { namespace StreamInfo { class FilterState {}; } }
