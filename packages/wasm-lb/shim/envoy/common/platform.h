#pragma once
// NOLINT(namespace-envoy)
// Minimal shadow of envoy/common/platform.h. The real header exists to smooth
// over Windows/Posix/BSD networking and byte-order differences and pulls a large
// set of socket/netfilter headers that emscripten does not ship. The lifted LB
// code needs only the little-endian conversion macros (BitArray packs its table
// little-endian); Wasm is always little-endian, so these are identities, exactly
// like Envoy's own fallback definitions.
#include <cstdint>

#ifndef htole16
#define htole16(x) (x)
#define htole32(x) (x)
#define htole64(x) (x)
#define le16toh(x) (x)
#define le32toh(x) (x)
#define le64toh(x) (x)
#endif
