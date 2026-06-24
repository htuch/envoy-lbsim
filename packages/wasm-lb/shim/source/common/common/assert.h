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
#define IS_ENVOY_BUG(...) (false)
