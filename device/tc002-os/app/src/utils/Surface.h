#ifndef UTILS_SURFACE_BRIDGE_H_
#define UTILS_SURFACE_BRIDGE_H_

// Bridge for the arcade game engines, which are compiled into this firmware
// unchanged from device/tc002-arcade/app/src/games/. They include
// "utils/Surface.h"; this firmware keeps the same class at core/Surface.h.
//
// Reusing the engines verbatim rather than porting them is deliberate: they are
// hardware-verified, their physics constants are copied from the web engines,
// and device/tc002-arcade/hostcheck/selfcheck.cpp already asserts all seven.
// A port would fork that guarantee for no gain.
#include "core/Surface.h"

#endif  // UTILS_SURFACE_BRIDGE_H_
