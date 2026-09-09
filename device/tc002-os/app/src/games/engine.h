#ifndef GAMES_ENGINE_H_
#define GAMES_ENGINE_H_

// Contract between the arcade shell (GamePage) and every game.
// Mirrors web/src/lib/games/engine.ts, adapted from sampled pointer input to
// discrete knob/button events. Keep in sync with docs/design/arcade-firmware.md §2.5.

class Surface;

struct GameInputEvent {
    enum Kind {
        KnobCw,        // one clockwise detent (no release event)
        KnobCcw,       // one counter-clockwise detent
        KnobPress,     // knob pushed
        Left,
        Middle,
        Right,
    };
    Kind kind;
    // Buttons report both edges; true = pressed. Knob rotation always true.
    bool down;
};

struct GameHud {
    enum Phase { Ready, Playing, Over };
    int score;
    int lives;      // -1 when the game has no lives concept
    Phase phase;
};

class GameEngine {
public:
    virtual ~GameEngine() {}
    // Stable identifier reported in the arcade heartbeat:
    // "breakout" | "flappy" | "snake" | "pong" | "racer" | "shooter" | "tetris"
    virtual const char* id() const = 0;
    virtual const char* title() const = 0;  // menu caption, ASCII, e.g. "BREAKOUT"
    virtual void reset() = 0;               // back to the Ready attract screen
    virtual void onInput(const GameInputEvent& event) = 0;
    // Advance the simulation; implementations clamp dtMs to <=250 and use a
    // fixed inner step (the physics constants are ports of the verified web
    // engines in web/src/lib/games/*.ts — keep them identical).
    virtual void tick(int dtMs) = 0;
    // Draw the current state onto a 52x16 surface, including the Ready
    // (attract) and Over (settlement) screens.
    virtual void render(Surface& surface) = 0;
    virtual GameHud hud() const = 0;
};

#endif  // GAMES_ENGINE_H_
