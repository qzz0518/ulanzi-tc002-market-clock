#include "games/eye.h"

#include "games/support.h"

namespace {

const Color kBarLit(120, 210, 140);
const Color kBarDim(24, 60, 34);
const Color kAttackLit(240, 170, 70);
const Color kText(150, 165, 200);

/** Small ints without dragging stdio in for six digits. */
void formatInt(int value, char* out, int size) {
	if (size <= 0) return;
	if (value < 0) { out[0] = '-'; out[1] = 0; return; }
	char digits[8];
	int count = 0;
	if (value == 0) digits[count++] = '0';
	while (value > 0 && count < 7) {
		digits[count++] = static_cast<char>('0' + (value % 10));
		value /= 10;
	}
	int written = 0;
	while (count > 0 && written < size - 1) out[written++] = digits[--count];
	out[written] = 0;
}

}  // namespace

EyeEngine::EyeEngine()
	: mSource(0), mSkin(tcos::kSkinNomi), mMeter(false), mGain(1.0f),
	  mGainFlashMs(0), mSkinFlashMs(0) {
	reset();
}

EyeEngine::~EyeEngine() {}

void EyeEngine::reset() {
	// GameScreen calls this on EVERY entry, so this is what opening the face
	// looks like: the first skin, default sensitivity, and a tracker that has
	// forgotten the last room — which is right, because it may be a different
	// room, and a stale floor would make a quiet one read as loud.
	mFace.reset(0);
	mLoudness.reset();
	mSkin = tcos::kSkinNomi;
	mMeter = false;
	mGain = 1.0f;
	mGainFlashMs = 0;
	mSkinFlashMs = 0;
}

void EyeEngine::onInput(const GameInputEvent& event) {
	// Act on the DOWN edge only, like every other engine here: the Shell sends
	// both edges for buttons and a release that also toggled would undo the press.
	switch (event.kind) {
		// The knob is for the thing you look at; the side keys are for the thing
		// you tune. Turning to change the FACE is the gesture worth having on the
		// knob — it is the whole reason to open this — and sensitivity is a
		// setting, which is what the +/- pair is for everywhere else on this
		// device.
		case GameInputEvent::KnobCw:
			if (!event.down) break;
			mSkin = static_cast<tcos::EyeSkin>((mSkin + 1) % tcos::kEyeSkinCount);
			mSkinFlashMs = 1400;
			break;
		case GameInputEvent::KnobCcw:
			if (!event.down) break;
			mSkin = static_cast<tcos::EyeSkin>(
				(mSkin + tcos::kEyeSkinCount - 1) % tcos::kEyeSkinCount);
			mSkinFlashMs = 1400;
			break;
		case GameInputEvent::KnobPress:
		case GameInputEvent::Middle:
			if (!event.down) break;
			mMeter = !mMeter;
			break;
		case GameInputEvent::Right:
			if (!event.down) break;
			mGain += 0.1f;
			if (mGain > 2.0f) mGain = 2.0f;
			mGainFlashMs = 1200;
			break;
		case GameInputEvent::Left:
			if (!event.down) break;
			mGain -= 0.1f;
			if (mGain < 0.5f) mGain = 0.5f;
			mGainFlashMs = 1200;
			break;
	}
}

void EyeEngine::tick(int dtMs) {
	if (dtMs <= 0) return;
	if (dtMs > 250) dtMs = 250;

	// A null source is the honest quiet case, not an error: on a device whose
	// MCU has not answered yet, the face idles rather than pretending to hear.
	const int raw = mSource ? mSource() : -1;
	mLoudness.push(raw, dtMs);

	float level = mLoudness.level() * mGain;
	if (level > 1.0f) level = 1.0f;
	// Attack rides the gain too, or turning sensitivity up makes the face
	// louder-eyed without making it any easier to startle — which is exactly
	// the knob people reach for when it is not reacting.
	float attack = mLoudness.attack() * mGain;
	if (attack > 1.0f) attack = 1.0f;

	mFace.tick(dtMs, level, attack);

	if (mGainFlashMs > 0) {
		mGainFlashMs -= dtMs;
		if (mGainFlashMs < 0) mGainFlashMs = 0;
	}
	if (mSkinFlashMs > 0) {
		mSkinFlashMs -= dtMs;
		if (mSkinFlashMs < 0) mSkinFlashMs = 0;
	}
}

void EyeEngine::render(Surface& surface) {
	if (mMeter) {
		renderMeter(surface);
		return;
	}
	tcos::drawEyeSkin(surface, mSkin, mFace.expression());

	// NO NAME IS DRAWN over the face. A 52x16 panel carrying a full-width face
	// has no free rows for a label — the first attempt put one across rows 11..15
	// and lit the bottom row every skin change, breaking the one edge rule every
	// skin obeys. It is also redundant: turning the knob visibly changes the
	// face, which is better feedback than a word. The name lives on the meter
	// page, where there is room for it.

	if (mGainFlashMs > 0) {
		// The sensitivity, as a scale rather than a bare column: the full travel
		// in dim green with the current value lit inside it. Only drawing the lit
		// part meant 0.5x showed a single dot in the corner with nothing to
		// measure it against, and the first person to see it had to ask what it
		// was.
		const int span = static_cast<int>((mGain - 0.5f) / 1.5f * 12.0f + 0.5f);
		for (int i = 0; i <= 12; ++i) {
			surface.setPixel(0, 14 - i, i <= span ? kBarLit : kBarDim);
		}
	}
}

void EyeEngine::renderMeter(Surface& surface) const {
	char buffer[8];

	// Raw reading, top-left. This is the number nobody has ever documented.
	formatInt(mLoudness.lastRaw(), buffer, sizeof(buffer));
	arcadegames::drawText3x5(surface, buffer, 1, 1, kText);
	arcadegames::drawText3x5(surface, tcos::eyeMoodName(mFace.mood()), 22, 1, kText);
	arcadegames::drawText3x5(surface, tcos::eyeSkinName(mSkin), 39, 1, kBarDim);

	// The window the tracker has settled on: floor on the left, ceiling on the
	// right. Watching these two separate is watching the calibration work.
	formatInt(mLoudness.floorRaw(), buffer, sizeof(buffer));
	arcadegames::drawText3x5(surface, buffer, 1, 11, kBarDim);
	formatInt(mLoudness.ceilRaw(), buffer, sizeof(buffer));
	arcadegames::drawText3x5(surface, buffer, 30, 11, kBarDim);

	// Level, full width, with the attack riding above it in a warmer colour so
	// a bang is visibly a different event from a loud steady tone.
	float level = mLoudness.level() * mGain;
	if (level > 1.0f) level = 1.0f;
	const int lit = static_cast<int>(level * 50.0f + 0.5f);
	for (int x = 0; x < 50; ++x) {
		surface.setPixel(1 + x, 8, x < lit ? kBarLit : kBarDim);
	}
	float attack = mLoudness.attack() * mGain;
	if (attack > 1.0f) attack = 1.0f;
	const int spike = static_cast<int>(attack * 50.0f + 0.5f);
	for (int x = 0; x < spike; ++x) {
		surface.setPixel(1 + x, 7, kAttackLit);
	}

	// Uncalibrated is a state worth saying out loud: until the floor and the
	// ceiling separate, the level is pinned at zero on purpose and a reader
	// would otherwise conclude the microphone is dead.
	if (!mLoudness.calibrated()) {
		arcadegames::drawText3x5(surface, "CAL", 20, 1, kAttackLit);
	}
}

GameHud EyeEngine::hud() const {
	// Nothing scores and nothing ends. GameScreen never draws a HUD — it clears,
	// ticks and hands the panel over — so this exists only to satisfy the
	// interface and to keep the arcade heartbeat's phase field honest.
	GameHud out;
	out.score = 0;
	out.lives = -1;
	out.phase = GameHud::Playing;
	return out;
}
