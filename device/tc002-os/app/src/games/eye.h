#ifndef GAMES_EYE_H_
#define GAMES_EYE_H_

#include "games/engine.h"
#include "visual/EyeFace.h"

/**
 * 「EYE」 — a face on the games ring that watches the room.
 *
 * Not a game in the arcade sense: nothing scores, nothing ends, nothing can be
 * lost. It earns its place on that ring because that is where the device's
 * full-screen, full-rate, input-owning things live — GameScreen hands an engine
 * the whole 52x16 panel with no HUD drawn over it, ticks it off the Shell's
 * 20 ms clock, and lets a hold walk back out. A channel could not have any of
 * that: channels are GIFs the service renders ahead of time and the device
 * merely replays, which is both a quarter of the frame rate and, fatally for
 * this, rendered before the room made any noise.
 *
 * THE MICROPHONE ARRIVES AS ONE NUMBER. The TC002's mic hangs off the MCU, not
 * the SoC — there is no PCM capture anywhere on this hardware. So the engine is
 * handed a raw 16-bit loudness reading through a function pointer and turns it
 * into behaviour itself. The indirection is not ceremony: McuManager drags in
 * the vendor MCU headers, which do not exist on macOS, and a game that called
 * it directly could not be compiled by any host check — which is precisely how
 * the battery charging test stayed wrong for the whole life of this firmware.
 * osLogic supplies the real source; the self-checks supply a scripted one and
 * drive every mood without a device.
 */
class EyeEngine : public GameEngine {
public:
	/** Returns the MCU's raw loudness value, or negative when it cannot be read. */
	typedef int (*MicSource)();

	EyeEngine();
	virtual ~EyeEngine();

	virtual const char* id() const override { return "eye"; }
	virtual const char* title() const override { return "EYE"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	/** Wired once by osLogic. Null leaves the face in its quiet idle. */
	void setMicSource(MicSource source) { mSource = source; }

	/**
	 * The calibration read-out, toggled by a knob press.
	 *
	 * Worth a button because NOTHING documents the MCU's loudness value — not
	 * the vendor SDK, not Ulanzi's own repository, which says only that the MCU
	 * "reports volume data" and gives no range, units or update rate. So the
	 * toy is also the instrument that measures it: raw reading, the floor and
	 * ceiling the tracker has settled on, and the level those produce.
	 */
	bool showsMeter() const { return mMeter; }

	tcos::EyeMood mood() const { return mFace.mood(); }
	const tcos::LoudnessTracker& loudness() const { return mLoudness; }
	const tcos::EyeFace& face() const { return mFace; }

	/** 0.5x .. 2.0x, on the +/- keys. Rooms differ; so do the things people shout at. */
	float gain() const { return mGain; }

	/** Which face is on. The knob turns through them. */
	tcos::EyeSkin skin() const { return mSkin; }

private:
	void renderMeter(Surface& surface) const;

	tcos::EyeFace mFace;
	tcos::LoudnessTracker mLoudness;
	MicSource mSource;
	tcos::EyeSkin mSkin;
	bool mMeter;
	float mGain;
	int mGainFlashMs;
	int mSkinFlashMs;
};

#endif  // GAMES_EYE_H_
