#ifndef PLATFORM_PREFS_H_
#define PLATFORM_PREFS_H_

namespace tcos {
namespace prefs {

/**
 * The handful of settings that must survive a power cycle.
 *
 * Written to /data, the one partition that is neither tmpfs nor read-only and
 * which a `res` flash does not touch — so settings also survive reinstalling
 * ZOS, which is the case that matters most while this firmware is still moving.
 *
 * NOT written to the stock app's /data/setting.ini. That file belongs to the
 * firmware a user restores when they want their clock back, and corrupting it
 * would turn "go back to stock" into "go back to stock, broken".
 *
 * Deliberately a flat key=value text file rather than the SDK's
 * StoragePreferences: that class is a fine API but it is one more dependency
 * for four integers, and a file a human can read over adb has repeatedly been
 * worth more on this device than one they cannot.
 *
 * WRITES ARE DEBOUNCED BY THE CALLER. /data is jffs2 on raw NAND; committing on
 * every knob detent would put a flash erase in the input path and wear the
 * partition for no reason. See DeviceControls::flushIfDue.
 */

/** Returns the stored value, or `fallback` when absent or unparseable. */
int getInt(const char* key, int fallback);

/** Stages a value in memory. Nothing reaches flash until commit(). */
void setInt(const char* key, int value);

/** True when a setInt has not yet been written. */
bool dirty();

/**
 * Writes the whole file, atomically: a temporary beside it, then rename. A
 * half-written prefs file on a device whose only recovery is adb is not worth
 * the two lines it saves.
 */
bool commit();

}  // namespace prefs
}  // namespace tcos

#endif  // PLATFORM_PREFS_H_
