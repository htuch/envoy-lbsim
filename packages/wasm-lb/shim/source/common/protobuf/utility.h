#pragma once
// Shim of source/common/protobuf/utility.h, reduced to the one macro the lifted
// LB code uses. PROTOBUF_GET_WRAPPED_OR_DEFAULT reads a google.protobuf wrapper
// field, falling back to a default when unset; we replicate its expansion so the
// real .cc compiles unmodified without the protobuf runtime.
#define PROTOBUF_GET_WRAPPED_OR_DEFAULT(message, field_name, default_value)                        \
  ((message).has_##field_name() ? (message).field_name().value() : (default_value))
