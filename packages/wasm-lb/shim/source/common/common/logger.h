#pragma once
// Shim of source/common/common/logger.h. Provides the Logger::Loggable<Id> base
#include "fmt/core.h"
// ring_hash_lb.cc calls absl::StrCat and relies on the transitive include the
// real (spdlog/fmt) logger.h provides; restore it here so the reduced graph keeps
// it visible (maglev never used StrCat, so this surfaced only with ring_hash).
#include "absl/strings/str_cat.h"
// and ENVOY_LOG* macros as no-ops so real Envoy code that logs compiles and runs
// without spdlog. The Id enum lists the ids referenced by lifted code; extend as
// more files are pulled in.

namespace Envoy {
namespace Logger {

enum class Id {
  upstream,
  misc,
  filter,
  connection,
  router,
  pool,
  health_checker,
  config,
  client,
  http,
  main,
  assert,
  testing,
};

template <Id id> class Loggable {
protected:
  Loggable() = default;
};

} // namespace Logger
} // namespace Envoy

#define ENVOY_LOGGER() (0)
#define GET_MISC_LOGGER() (0)
#define ENVOY_LOG(...) (static_cast<void>(0))
#define ENVOY_LOG_MISC(...) (static_cast<void>(0))
#define ENVOY_LOG_TO_LOGGER(...) (static_cast<void>(0))
#define ENVOY_CONN_LOG(...) (static_cast<void>(0))
#define ENVOY_LOG_EVERY_POW_2(...) (static_cast<void>(0))
#define ENVOY_LOG_EVERY_NTH(...) (static_cast<void>(0))
#define ENVOY_LOG_FIRST_N(...) (static_cast<void>(0))
#define ENVOY_LOG_ONCE(...) (static_cast<void>(0))
#define ENVOY_LOG_CHECK_LEVEL(...) (false)
#define ENVOY_FLUSH_LOG() (static_cast<void>(0))

#define FINE_GRAIN_LOG(...) (static_cast<void>(0))
#define ENVOY_LOG_EVERY_POW_2_MISC(...) (static_cast<void>(0))
