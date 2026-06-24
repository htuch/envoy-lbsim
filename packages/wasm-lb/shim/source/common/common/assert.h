#pragma once
// Shim of source/common/common/assert.h. We keep RELEASE_ASSERT live (so real
// invariant violations still abort) and make debug ASSERT/ENVOY_BUG no-ops, which
// is exactly what an opt build of Envoy does.
#include <cstdlib>

#define ASSERT(...) (static_cast<void>(0))
#define RELEASE_ASSERT(X, DETAILS)                                                                  \
  do {                                                                                              \
    if (!(X)) {                                                                                     \
      ::abort();                                                                                    \
    }                                                                                               \
  } while (0)
#define ENVOY_BUG(...) (static_cast<void>(0))
#define NOT_REACHED_GCOVR_EXCL_LINE ::abort();
#define PANIC(X) ::abort()
#define PANIC_DUE_TO_CORRUPT_ENUM ::abort();
#define PANIC_ON_PROTO_ENUM_SENTINEL_VALUES ::abort();
#define IS_ENVOY_BUG(...) (false)

// Status-propagation helper used by lifted factory code: on a non-ok status,
// assign it to the out-param and return from the void function.
#define SET_AND_RETURN_IF_NOT_OK(status_expr, out_status)                                           \
  do {                                                                                              \
    if (const absl::Status s__ = (status_expr); !s__.ok()) {                                        \
      (out_status) = s__;                                                                           \
      return;                                                                                       \
    }                                                                                              \
  } while (0)
