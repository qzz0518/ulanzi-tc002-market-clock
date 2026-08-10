#ifndef GAMES_TETRIS_H_
#define GAMES_TETRIS_H_

#include <stdint.h>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Sideways tetris built for the device (no web counterpart): gravity pulls
// LEFT. The well is 40 deep (screen x=8..47, internal x 0=floor..39=entry) by
// 10 wide (screen y=3..12, internal y 0..9); the walls at screen x=7 and
// y=2/13 are a dark-tier outline. Seven SRS tetrominoes spawn in a 4x4 box at
// internal x=36 (screen x>=44), y centred. Fall interval starts at 800ms and
// drops 60ms per 4 cleared columns (floor 140ms). Knob cw/ccw shifts the
// piece along y +1/-1, middle or knob press rotates clockwise (kicks: +1y,
// -1y, +1x), Left held soft-drops at 8x, Right hard-drops with a landing
// flash. Full columns (all 10 y at one x) clear; everything right of them
// shifts left; 1/2/3/4 columns score 100/300/500/800 x level.
class TetrisEngine : public GameEngine {
public:
	TetrisEngine();
	virtual ~TetrisEngine();

	virtual const char* id() const override { return "tetris"; }
	virtual const char* title() const override { return "TETRIS"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic piece sequence for the host selfcheck. The engine draws
	// exactly one pick(7) per spawned piece, in spawn order, and nothing else
	// from mRandom — the selfcheck replays the sequence with its own
	// GameRandom to hunt for seeds.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck (internal well coordinates).
	int pieceX() const { return mPieceX; }
	int pieceY() const { return mPieceY; }
	int rotation() const { return mRotation; }
	int currentPieceId() const { return mPiece; }
	int nextPieceId() const { return mNext; }
	int filledCount() const;
	int clearedColumns() const { return mCleared; }
	int level() const;

private:
	static const int kDepth = 40;  // internal x, 0 = floor (screen x=8)
	static const int kWidth = 10;  // internal y (screen y=3)

	void resetState();
	bool fits(int piece, int rot, int px, int py) const;
	void spawn();
	void lockPiece(bool flash);
	int clearFullColumns();  // returns cleared column count
	void tryShift(int dy);
	void tryRotate();
	void hardDrop();
	double intervalMs() const;
	bool blink(double periodMs) const;
	void renderWalls(Surface& s);
	void renderHud(Surface& s);
	void renderGameOver(Surface& s);

	int8_t mBoard[kDepth][kWidth];  // -1 empty, else piece id (for color)
	int mScore;
	int mCleared;  // total cleared columns
	GameHud::Phase mPhase;
	int mPiece;     // 0..6
	int mNext;      // 0..6
	int mRotation;  // 0..3
	int mPieceX;    // 4x4 box origin, internal coords
	int mPieceY;
	double mDropMs;  // accumulator toward the next gravity step
	double mElapsedMs;
	double mOverMs;
	double mFlashMs;  // hard-drop landing flash countdown
	int8_t mFlashCells[4][2];
	int mFlashCount;
	bool mSoftHeld;
	bool mConfirmEdge;
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_TETRIS_H_
