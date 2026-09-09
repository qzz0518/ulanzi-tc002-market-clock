#ifndef UTILS_SURFACE_BRIDGE_H_
#define UTILS_SURFACE_BRIDGE_H_

// Bridge for the game engines under games/, which were written for the retired
// arcade firmware and include "utils/Surface.h"; this firmware keeps the same
// class at core/Surface.h.
//
// The engines moved here verbatim (ADR 0014) rather than being ported: they are
// hardware-verified, their physics constants are copied from the web engines,
// and hostcheck/games-selfcheck.cpp asserts all seven against this very
// header. Rewriting their include lines would be the one edit that could not
// be verified by that check, for no gain.
#include "core/Surface.h"

#endif  // UTILS_SURFACE_BRIDGE_H_
