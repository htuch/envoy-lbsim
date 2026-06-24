#pragma once
// Shim of source/common/common/utility.h, reduced to Primes::isPrime -- the only
// utility the lifted maglev code calls (to assert its table size is prime). This
// is a faithful copy of Envoy's trivial primality test so the (otherwise inert)
// validation behaves identically if reached.
#include <cstdint>

namespace Envoy {

class Primes {
public:
  // Smallest-factor trial division, matching Envoy's implementation.
  static bool isPrime(uint32_t x) {
    if (x < 2) {
      return false;
    }
    for (uint64_t i = 2; i * i <= x; i++) {
      if (x % i == 0) {
        return false;
      }
    }
    return true;
  }
};

} // namespace Envoy
