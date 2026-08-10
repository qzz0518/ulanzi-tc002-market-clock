// Host-side smoke test for the seven game engines. Compiles the real engine
// translation units plus the real Surface against plain libc++ (no FlyThings
// headers involved) and drives them with asserts:
//
//   cd device/tc002-arcade && clang++ -std=gnu++11 -Wall -Wextra \
//     -I app/src hostcheck/selfcheck.cpp app/src/games/*.cpp \
//     app/src/utils/Surface.cpp -o /tmp/arcade-selfcheck && /tmp/arcade-selfcheck
//
// This directory sits outside app/, so the firmware Makefile's
// `find $(APP)/src -name '*.cpp'` never collects it.

#include <cassert>
#include <cstdio>
#include <cstring>

#include "games/breakout.h"
#include "games/flappy.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/snake.h"
#include "games/tetris.h"
#include "utils/Surface.h"

namespace {

GameInputEvent ev(GameInputEvent::Kind kind, bool down = true) {
	GameInputEvent e;
	e.kind = kind;
	e.down = down;
	return e;
}

// Advance in UI-timer-sized slices (30ms = the arcade tick period).
void run(GameEngine& g, int ms, int stepMs = 30) {
	for (int t = 0; t < ms; t += stepMs) g.tick(stepMs);
}

int litPixels(GameEngine& g) {
	Surface s(52, 16, Color(0, 0, 0));
	g.render(s);
	int n = 0;
	for (int y = 0; y < 16; ++y) {
		for (int x = 0; x < 52; ++x) {
			const Color c = s.getPixel(x, y);
			if (c.r || c.g || c.b) ++n;
		}
	}
	return n;
}

void checkBreakout() {
	BreakoutEngine b;
	assert(std::strcmp(b.id(), "breakout") == 0);
	assert(std::strcmp(b.title(), "BREAKOUT") == 0);
	assert(b.hud().phase == GameHud::Ready);
	assert(b.hud().score == 0);
	assert(b.hud().lives == 3);
	assert(litPixels(b) > 20);  // attract board: clock bricks + paddle + ball

	// Attract screen idles without input.
	run(b, 500);
	assert(b.hud().phase == GameHud::Ready);

	// Knob press starts the run. Park the paddle far left immediately: the
	// serve still climbs into the brick band (scoring), and the returns drain
	// all three lives. (A centred static paddle can trap the deterministic
	// ball in a stable bounce cycle — a property shared with the web sim.)
	b.onInput(ev(GameInputEvent::KnobPress));
	b.tick(30);
	assert(b.hud().phase == GameHud::Playing);
	b.onInput(ev(GameInputEvent::Left, true));
	int waited = 0;
	while (b.hud().phase != GameHud::Over && waited < 60000) {
		b.tick(30);
		waited += 30;
	}
	assert(b.hud().phase == GameHud::Over);
	assert(b.hud().score > 0);
	assert(b.hud().lives == 0);
	b.onInput(ev(GameInputEvent::Left, false));

	// Settlement screen is locked for 800ms, then a press replays immediately.
	b.onInput(ev(GameInputEvent::KnobPress));
	b.tick(30);
	assert(b.hud().phase == GameHud::Over);
	run(b, 900);
	b.onInput(ev(GameInputEvent::Middle));
	b.tick(30);
	assert(b.hud().phase == GameHud::Playing);
	assert(b.hud().score == 0);
	assert(b.hud().lives == 3);

	// Pause freezes the simulation.
	b.onInput(ev(GameInputEvent::KnobPress));
	b.tick(30);
	assert(b.paused());
	const double frozenX = b.ballX();
	const double frozenY = b.ballY();
	run(b, 500);
	assert(b.ballX() == frozenX && b.ballY() == frozenY);
	b.onInput(ev(GameInputEvent::KnobPress));
	b.tick(30);
	assert(!b.paused());
	std::printf("breakout ok\n");
}

void checkFlappy() {
	FlappyEngine f;
	f.seedRandom(42);
	f.reset();
	assert(std::strcmp(f.id(), "flappy") == 0);
	assert(f.hud().phase == GameHud::Ready);
	assert(f.hud().lives == -1);
	assert(f.pipeCount() == 4);
	assert(litPixels(f) > 0);  // ground + bobbing bird

	// dt is clamped to 250ms: one huge tick right after the first flap must
	// not kill the bird (unclamped it would fall through the ground).
	f.onInput(ev(GameInputEvent::Left));
	f.tick(10000);
	assert(f.hud().phase == GameHud::Playing);

	// No further flaps: gravity grounds the bird.
	int fell = 0;
	while (f.hud().phase != GameHud::Over && fell < 4000) {
		f.tick(30);
		fell += 30;
	}
	assert(f.hud().phase == GameHud::Over);

	// 600ms restart lockout, then knob-press restarts to the attract screen.
	f.onInput(ev(GameInputEvent::KnobPress));
	f.tick(30);
	assert(f.hud().phase == GameHud::Over);
	run(f, 700);
	f.onInput(ev(GameInputEvent::KnobPress));
	f.tick(30);
	assert(f.hud().phase == GameHud::Ready);
	assert(f.hud().score == 0);

	// Any button starts again.
	f.onInput(ev(GameInputEvent::Middle));
	f.tick(30);
	assert(f.hud().phase == GameHud::Playing);
	std::printf("flappy ok\n");
}

void checkSnake() {
	// Turn queueing + 180-degree guard: ccw turns right→up; a second ccw wants
	// left (the straight reversal of the committed right) and is rejected.
	{
		SnakeEngine s;
		s.seedRandom(7);
		s.reset();
		assert(std::strcmp(s.id(), "snake") == 0);
		assert(s.hud().phase == GameHud::Ready);
		assert(s.headX() == 8 && s.headY() == 8);
		assert(s.length() == 4);

		s.onInput(ev(GameInputEvent::KnobCcw));  // also starts the run
		s.tick(30);
		assert(s.hud().phase == GameHud::Playing);
		s.onInput(ev(GameInputEvent::KnobCcw));  // rejected reversal
		s.tick(30);
		s.tick(30);  // accumulator crosses one 83.3ms step here
		assert(s.headX() == 8);
		assert(s.headY() == 7);  // moved up, not left
	}

	// Speed is 12 cells/s at level 1, and a dot on the straight path is eaten.
	{
		uint32_t seed = 0;
		for (uint32_t candidate = 1; candidate < 20000; ++candidate) {
			SnakeEngine probe;
			probe.seedRandom(candidate);
			probe.reset();
			if (probe.foodIsDigit()) continue;
			const SnakeEngine::Cell food = probe.foodCells()[0];
			if (food.y == 8 && food.x >= 12 && food.x <= 44) {
				seed = candidate;
				break;
			}
		}
		assert(seed != 0);

		SnakeEngine s;
		s.seedRandom(seed);
		s.reset();
		s.onInput(ev(GameInputEvent::Middle));  // start without turning
		run(s, 1000);
		assert(s.hud().phase == GameHud::Playing);
		assert(s.headY() == 8);
		assert(s.headX() == 20);  // 12 steps in the first second
		int walled = 0;           // run into the right wall
		while (s.hud().phase != GameHud::Over && walled < 6000) {
			s.tick(30);
			walled += 30;
		}
		assert(s.hud().phase == GameHud::Over);
		assert(s.hud().score >= 1);  // the dot on the path was eaten

		// Restart lockout.
		s.onInput(ev(GameInputEvent::KnobPress));
		s.tick(30);
		assert(s.hud().phase == GameHud::Over);
		run(s, 700);
		s.onInput(ev(GameInputEvent::KnobPress));
		s.tick(30);
		assert(s.hud().phase == GameHud::Ready);
	}

	// The digit bonus food spawns as a 3x5 glyph patch.
	{
		bool found = false;
		for (uint32_t candidate = 1; candidate < 20000 && !found; ++candidate) {
			SnakeEngine probe;
			probe.seedRandom(candidate);
			probe.reset();
			if (!probe.foodIsDigit()) continue;
			found = true;
			const int n = (int)probe.foodCells().size();
			assert(n > 0 && n <= 15);
			for (int i = 0; i < n; ++i) {
				const SnakeEngine::Cell c = probe.foodCells()[i];
				assert(c.x >= 0 && c.x < 52 && c.y >= 0 && c.y < 16);
			}
		}
		assert(found);
	}
	std::printf("snake ok\n");
}

void checkPong() {
	PongEngine p;
	p.seedRandom(3);
	p.reset();
	assert(std::strcmp(p.id(), "pong") == 0);
	assert(p.hud().phase == GameHud::Ready);
	assert(p.hud().lives == -1);
	assert(litPixels(p) > 0);  // paddles + midline

	run(p, 500);
	assert(p.hud().phase == GameHud::Ready);

	p.onInput(ev(GameInputEvent::KnobPress));
	p.tick(30);
	assert(p.hud().phase == GameHud::Playing);

	// Static left paddle vs the speed-capped AI: someone reaches 9 points.
	int waited = 0;
	while (p.hud().phase != GameHud::Over && waited < 1200000) {
		p.tick(30);
		waited += 30;
	}
	assert(p.hud().phase == GameHud::Over);
	assert(p.scoreLeft() == 9 || p.scoreRight() == 9);
	assert(p.hud().score == p.scoreLeft());

	// Restart lockout, then back to the attract screen.
	p.onInput(ev(GameInputEvent::Middle));
	p.tick(30);
	assert(p.hud().phase == GameHud::Over);
	run(p, 700);
	p.onInput(ev(GameInputEvent::Middle));
	p.tick(30);
	assert(p.hud().phase == GameHud::Ready);
	assert(p.scoreLeft() == 0 && p.scoreRight() == 0);

	// Knob detents move the left paddle: two quick cw detents accelerate.
	p.onInput(ev(GameInputEvent::KnobPress));
	p.tick(30);
	assert(p.hud().phase == GameHud::Playing);
	const double before = p.leftTop();
	p.onInput(ev(GameInputEvent::KnobCw));
	p.onInput(ev(GameInputEvent::KnobCw));  // within the 150ms window: 2px + 4px
	p.tick(30);
	assert(p.leftTop() > before);
	std::printf("pong ok\n");
}

void checkRacer() {
	RacerEngine r;
	r.seedRandom(11);
	r.reset();
	assert(std::strcmp(r.id(), "racer") == 0);
	assert(std::strcmp(r.title(), "RACER") == 0);
	assert(r.hud().phase == GameHud::Ready);
	assert(r.hud().score == 0);
	assert(r.hud().lives == -1);
	assert(r.playerLane() == 1);  // starts on lane 2 of 4
	assert(litPixels(r) > 0);     // road texture + idling car (+ title)

	// Attract screen idles without input.
	run(r, 500);
	assert(r.hud().phase == GameHud::Ready);

	// Confirm starts; lane changes are discrete and immediate.
	r.onInput(ev(GameInputEvent::KnobPress));
	r.tick(30);
	assert(r.hud().phase == GameHud::Playing);
	r.onInput(ev(GameInputEvent::KnobCw));  // cw = next lane (down)
	assert(r.playerLane() == 2);
	r.onInput(ev(GameInputEvent::KnobCcw));
	assert(r.playerLane() == 1);
	r.onInput(ev(GameInputEvent::Left));  // left button = up
	r.onInput(ev(GameInputEvent::Left, false));
	assert(r.playerLane() == 0);
	r.onInput(ev(GameInputEvent::Left));  // clamped at the top lane
	r.onInput(ev(GameInputEvent::Left, false));
	assert(r.playerLane() == 0);
	r.onInput(ev(GameInputEvent::Right));  // right button = down
	r.onInput(ev(GameInputEvent::Right, false));
	assert(r.playerLane() == 1);

	// Dodge bot: waves block at most 2 adjacent lanes, so hopping to a free
	// lane before the nearest wave arrives survives indefinitely. Each dodged
	// car scores 10.
	{
		RacerEngine b;
		b.seedRandom(21);
		b.reset();
		b.onInput(ev(GameInputEvent::KnobPress));
		b.tick(30);
		int guard = 0;
		while (b.hud().phase == GameHud::Playing && b.hud().score < 150 && guard < 4000) {
			double nearest = 1e9;
			for (int i = 0; i < b.carCount(); ++i)
				if (b.carX(i) + 4.0 > 4.0 && b.carX(i) < nearest) nearest = b.carX(i);
			bool blocked[4] = {false, false, false, false};
			if (nearest < 1e8) {
				for (int i = 0; i < b.carCount(); ++i)
					if (b.carX(i) + 4.0 > 4.0 && b.carX(i) < nearest + 6.0)
						blocked[b.carLane(i)] = true;
			}
			if (blocked[b.playerLane()]) {
				int target = -1;
				int best = 9;
				for (int lane = 0; lane < 4; ++lane) {
					const int d = lane > b.playerLane()
						? lane - b.playerLane() : b.playerLane() - lane;
					if (!blocked[lane] && d < best) {
						best = d;
						target = lane;
					}
				}
				assert(target >= 0);  // a wave never blocks all four lanes
				while (b.playerLane() != target) {
					const GameInputEvent::Kind k = target < b.playerLane()
						? GameInputEvent::Left : GameInputEvent::Right;
					b.onInput(ev(k));
					b.onInput(ev(k, false));
				}
			}
			b.tick(30);
			++guard;
		}
		assert(b.hud().phase == GameHud::Playing);
		assert(b.hud().score >= 150);
		assert(b.hud().score == b.dodged() * 10);
	}

	// A static driver eventually meets a wave in its lane: collision ends the
	// run, the first frames flash the crash, and the lockout gates the restart.
	{
		bool crashed = false;
		for (uint32_t seed = 1; seed <= 60 && !crashed; ++seed) {
			RacerEngine c;
			c.seedRandom(seed);
			c.reset();
			c.onInput(ev(GameInputEvent::KnobPress));
			c.tick(30);
			int waited = 0;
			while (c.hud().phase == GameHud::Playing && waited < 30000) {
				c.tick(30);
				waited += 30;
			}
			if (c.hud().phase != GameHud::Over) continue;
			crashed = true;
			assert(litPixels(c) > 0);  // crash flash frame
			c.onInput(ev(GameInputEvent::KnobPress));
			c.tick(30);
			assert(c.hud().phase == GameHud::Over);  // restart lockout
			run(c, 700);
			c.onInput(ev(GameInputEvent::Middle));
			c.tick(30);
			assert(c.hud().phase == GameHud::Ready);
			assert(c.hud().score == 0);
		}
		assert(crashed);
	}
	std::printf("racer ok\n");
}

void checkShooter() {
	ShooterEngine sh;
	sh.seedRandom(5);
	sh.reset();
	assert(std::strcmp(sh.id(), "shooter") == 0);
	assert(std::strcmp(sh.title(), "SHOOTER") == 0);
	assert(sh.hud().phase == GameHud::Ready);
	assert(sh.hud().lives == 3);
	assert(litPixels(sh) > 0);  // stars + bobbing ship (+ title)

	run(sh, 500);
	assert(sh.hud().phase == GameHud::Ready);

	// Confirm starts; knob detents move 2px, x2 within the 150ms window;
	// held buttons glide at 24 px/s.
	sh.onInput(ev(GameInputEvent::Middle));
	sh.onInput(ev(GameInputEvent::Middle, false));
	sh.tick(30);
	assert(sh.hud().phase == GameHud::Playing);
	assert(sh.shipTop() == 6.0);
	sh.onInput(ev(GameInputEvent::KnobCw));
	sh.onInput(ev(GameInputEvent::KnobCw));  // accelerated detent: 2px + 4px
	assert(sh.shipTop() == 12.0);
	sh.onInput(ev(GameInputEvent::Left));  // held = up
	run(sh, 510);
	assert(sh.shipTop() < 0.5);
	sh.onInput(ev(GameInputEvent::Left, false));

	// Holding fire autofires at the 140ms cooldown into the 4-bullet cap.
	sh.onInput(ev(GameInputEvent::Middle));
	run(sh, 600);
	assert(sh.bulletCount() == 4);
	sh.onInput(ev(GameInputEvent::Middle, false));

	// A wave whose enemy crosses the bullet row gets shot: +10 per kill.
	{
		uint32_t seed = 0;
		for (uint32_t candidate = 1; candidate <= 2000 && seed == 0; ++candidate) {
			ShooterEngine p;
			p.seedRandom(candidate);
			p.reset();
			p.onInput(ev(GameInputEvent::Middle));
			p.onInput(ev(GameInputEvent::Middle, false));
			p.tick(30);
			int waited = 0;
			while (p.enemyCount() == 0 && waited < 2000) {
				p.tick(30);
				waited += 30;
			}
			// Ship stays at top 6 -> bullet row 7; enemy rows y..y+2 must cover it.
			if (p.enemyCount() == 1 && p.enemyY(0) >= 5 && p.enemyY(0) <= 7)
				seed = candidate;
		}
		assert(seed != 0);

		ShooterEngine k;
		k.seedRandom(seed);
		k.reset();
		k.onInput(ev(GameInputEvent::Middle));
		k.onInput(ev(GameInputEvent::Middle, false));
		k.tick(30);
		k.onInput(ev(GameInputEvent::Middle));  // hold fire
		run(k, 4000);
		assert(k.kills() >= 1);
		assert(k.hud().score == k.kills() * 10);
		assert(k.hud().lives == 3);  // nothing slipped past while covered
	}

	// Unopposed enemies leak past x=0 and drain the three lives.
	{
		ShooterEngine l;
		l.seedRandom(5);
		l.reset();
		l.onInput(ev(GameInputEvent::KnobPress));
		l.onInput(ev(GameInputEvent::KnobPress, false));
		l.tick(30);
		int waited = 0;
		while (l.hud().lives == 3 && waited < 12000) {
			l.tick(30);
			waited += 30;
		}
		assert(l.hud().lives < 3);
		waited = 0;
		while (l.hud().phase != GameHud::Over && waited < 60000) {
			l.tick(30);
			waited += 30;
		}
		assert(l.hud().phase == GameHud::Over);
		assert(l.hud().lives == 0);
		assert(litPixels(l) > 0);  // settlement: score + kill count

		// Restart lockout, then back to the attract screen.
		l.onInput(ev(GameInputEvent::Middle));
		l.tick(30);
		assert(l.hud().phase == GameHud::Over);
		run(l, 700);
		l.onInput(ev(GameInputEvent::Middle));
		l.tick(30);
		assert(l.hud().phase == GameHud::Ready);
		assert(l.hud().score == 0);
		assert(l.hud().lives == 3);
	}
	std::printf("shooter ok\n");
}

// The tetris engine consumes exactly one pick(7) per spawned piece and
// nothing else, so replaying GameRandom finds seeds with a wanted opening
// sequence (0=I .. 3=O .. 6=Z).
uint32_t findTetrisSeed(const int* want, int n) {
	for (uint32_t candidate = 1; candidate <= 500000; ++candidate) {
		arcadegames::GameRandom r;
		r.seed(candidate);
		bool ok = true;
		for (int i = 0; i < n; ++i) {
			if (r.pick(7) != want[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return candidate;
	}
	return 0;
}

void tetrisRotate(TetrisEngine& t) {
	t.onInput(ev(GameInputEvent::Middle));
	t.onInput(ev(GameInputEvent::Middle, false));
}

void tetrisDrop(TetrisEngine& t) {
	t.onInput(ev(GameInputEvent::Right));
	t.onInput(ev(GameInputEvent::Right, false));
	t.tick(30);
}

void tetrisStart(TetrisEngine& t, uint32_t seed) {
	t.seedRandom(seed);
	t.reset();
	t.onInput(ev(GameInputEvent::KnobPress));
	t.tick(30);
	assert(t.hud().phase == GameHud::Playing);
}

void checkTetris() {
	TetrisEngine t;
	t.seedRandom(9);
	t.reset();
	assert(std::strcmp(t.id(), "tetris") == 0);
	assert(std::strcmp(t.title(), "TETRIS") == 0);
	assert(t.hud().phase == GameHud::Ready);
	assert(t.hud().lives == -1);
	assert(t.level() == 1);
	assert(litPixels(t) > 0);  // well outline + blinking title
	run(t, 500);
	assert(t.hud().phase == GameHud::Ready);

	const int wantI[1] = {0};
	const uint32_t seedI = findTetrisSeed(wantI, 1);
	assert(seedI != 0);

	// Shift bounds and the rotate wall kick (I piece: 0 -> R -> 2, ride the
	// far rail, then the L rotation only fits after the -1y kick).
	{
		TetrisEngine k;
		tetrisStart(k, seedI);
		assert(k.currentPieceId() == 0);  // seed replay holds
		assert(k.pieceX() == 36);         // spawn box at screen x>=44
		assert(k.pieceY() == 3);
		tetrisRotate(k);  // 0 -> R
		tetrisRotate(k);  // R -> 2
		assert(k.rotation() == 2);
		for (int i = 0; i < 5; ++i) k.onInput(ev(GameInputEvent::KnobCw));
		assert(k.pieceY() == 7);  // fifth shift rejected at the rail
		tetrisRotate(k);          // 2 -> L: base + +1y fail, -1y kick lands
		assert(k.rotation() == 3);
		assert(k.pieceY() == 6);
	}

	// Soft drop runs gravity at 8x (800ms -> 100ms); hard drop locks at the
	// floor and respawns at the entry.
	{
		TetrisEngine d;
		tetrisStart(d, seedI);
		d.onInput(ev(GameInputEvent::Left));  // hold soft drop
		run(d, 450);
		assert(d.pieceX() == 32);  // four 100ms steps, plain gravity managed 0
		d.onInput(ev(GameInputEvent::Left, false));
		d.onInput(ev(GameInputEvent::Right));
		d.onInput(ev(GameInputEvent::Right, false));
		assert(d.filledCount() == 4);  // locked at the floor...
		assert(d.pieceX() == 36);      // ...and the next piece spawned
		assert(d.hud().score == 0);
	}

	// Single column clear: two vertical I bars fill x=0 rows 0..7, the O caps
	// rows 8..9 -> 100 x level 1, the O's second column shifts onto the floor.
	{
		const int wantIIO[3] = {0, 0, 3};
		const uint32_t seed = findTetrisSeed(wantIIO, 3);
		assert(seed != 0);
		TetrisEngine c;
		tetrisStart(c, seed);
		tetrisRotate(c);  // I upright
		for (int i = 0; i < 3; ++i) c.onInput(ev(GameInputEvent::KnobCcw));
		tetrisDrop(c);  // (0, 0..3)
		tetrisRotate(c);
		c.onInput(ev(GameInputEvent::KnobCw));
		tetrisDrop(c);  // (0, 4..7)
		for (int i = 0; i < 5; ++i) c.onInput(ev(GameInputEvent::KnobCw));
		tetrisDrop(c);  // O at (0..1, 8..9): column 0 completes
		assert(c.hud().score == 100);
		assert(c.clearedColumns() == 1);
		assert(c.filledCount() == 2);  // the O's outer column shifted left
	}

	// Double column clear: four I bars + the O cap complete x=0 and x=1
	// together -> 300 x level 1 and an empty board.
	{
		const int wantIIIIO[5] = {0, 0, 0, 0, 3};
		const uint32_t seed = findTetrisSeed(wantIIIIO, 5);
		assert(seed != 0);
		TetrisEngine c;
		tetrisStart(c, seed);
		for (int piece = 0; piece < 4; ++piece) {
			tetrisRotate(c);
			if (piece % 2 == 0) {
				for (int i = 0; i < 3; ++i) c.onInput(ev(GameInputEvent::KnobCcw));
			} else {
				c.onInput(ev(GameInputEvent::KnobCw));
			}
			tetrisDrop(c);  // I bars at (0,0..3) (0,4..7) (1,0..3) (1,4..7)
		}
		for (int i = 0; i < 5; ++i) c.onInput(ev(GameInputEvent::KnobCw));
		tetrisDrop(c);  // O caps both columns
		assert(c.hud().score == 300);
		assert(c.clearedColumns() == 2);
		assert(c.filledCount() == 0);
	}

	// Mindless hard drops never clear (rows 0..2 and 7..9 stay empty), so the
	// stack reaches the entry and the next spawn fails.
	{
		TetrisEngine o;
		tetrisStart(o, 1);
		for (int i = 0; i < 300 && o.hud().phase == GameHud::Playing; ++i)
			tetrisDrop(o);
		assert(o.hud().phase == GameHud::Over);
		assert(litPixels(o) > 0);  // settlement: score + cleared count
		o.onInput(ev(GameInputEvent::KnobPress));
		o.tick(30);
		assert(o.hud().phase == GameHud::Over);  // restart lockout
		run(o, 700);
		o.onInput(ev(GameInputEvent::KnobPress));
		o.tick(30);
		assert(o.hud().phase == GameHud::Ready);
		assert(o.hud().score == 0);
		assert(o.filledCount() == 0);
	}
	std::printf("tetris ok\n");
}

}  // namespace

int main() {
	checkBreakout();
	checkFlappy();
	checkSnake();
	checkPong();
	checkRacer();
	checkShooter();
	checkTetris();
	std::printf("all engine selfchecks passed\n");
	return 0;
}
