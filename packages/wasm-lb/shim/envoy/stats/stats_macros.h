#pragma once
// Shim of envoy/stats/stats_macros.h. The real macros declare Gauge& references
// bound from a Stats::Pool via symbol-table lookups; that machinery is absent in
// the harness. We instead make GENERATE_GAUGE_STRUCT emit value-typed gauges, so
// a stats struct is default-constructible and can be handed to the real table
// builder (which only set()s the gauges). POOL_GAUGE expands to an inert gauge
// initializer purely so the unused generateStats() path still compiles.
#include "envoy/stats/scope.h"

// Member declaration: value-typed gauge (real Envoy uses Gauge&).
#define GENERATE_GAUGE_STRUCT(NAME, MODE) Envoy::Stats::Gauge NAME##_;

// Construction: `ALL_X_STATS(POOL_GAUGE(scope))` expands each GAUGE(name, mode)
// entry by applying POOL_GAUGE(scope) to it. POOL_GAUGE(scope) yields the
// function-like macro below, which produces one brace-init element per gauge.
#define POOL_GAUGE(POOL) ELBSIM_GAUGE_INIT_
#define ELBSIM_GAUGE_INIT_(NAME, MODE) Envoy::Stats::Gauge{},
