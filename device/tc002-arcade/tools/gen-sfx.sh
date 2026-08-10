#!/bin/sh
# Synthesize the five 8-bit-style arcade sound effects into app/sfx/.
# Square waves built from ffmpeg's expression evaluator (aevalsrc), rendered
# as 16kHz mono s16 WAV with -bitexact so the header is the canonical 44
# bytes SfxManager expects. Each clip stays well under 30KB.
#
# Usage: tools/gen-sfx.sh   (from device/tc002-arcade/; needs ffmpeg)
set -e

FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
[ -x "$FFMPEG" ] || FFMPEG=ffmpeg
OUT="$(dirname "$0")/../app/sfx"
mkdir -p "$OUT"

# gen <name> <duration> <expression>
# Square wave primitive: (2*lt(mod(t*F,1),0.5)-1) — no reliance on sgn().
gen() {
	"$FFMPEG" -hide_banner -loglevel error -y \
		-f lavfi -i "aevalsrc=exprs='$3':s=16000:d=$2" \
		-ac 1 -c:a pcm_s16le -bitexact -f wav "$OUT/$1.wav"
	echo "  $1.wav  $(wc -c < "$OUT/$1.wav" | tr -d ' ') bytes"
}

# boot: rising C-major arpeggio C5 E5 G5 C6, 150ms per note, ~600ms
gen boot 0.6 '(2*lt(mod(t*if(lt(t,0.15),523,if(lt(t,0.3),659,if(lt(t,0.45),784,1047))),1),0.5)-1)*0.30*exp(-8*mod(t,0.15))'

# tick: 30ms C7 blip for menu detents
gen tick 0.03 '(2*lt(mod(t*2093,1),0.5)-1)*0.28*exp(-70*t)'

# confirm: two-tone E5 -> B5, 60ms each
gen confirm 0.12 '(2*lt(mod(t*if(lt(t,0.06),659,988),1),0.5)-1)*0.30*exp(-20*mod(t,0.06))'

# score: upward double blip A5 -> E6, 75ms each
gen score 0.15 '(2*lt(mod(t*if(lt(t,0.075),880,1319),1),0.5)-1)*0.30*exp(-18*mod(t,0.075))'

# over: descending G5 -> Eb5 -> B4, ~166ms each
gen over 0.5 '(2*lt(mod(t*if(lt(t,0.166),784,if(lt(t,0.333),622,494)),1),0.5)-1)*0.30*exp(-9*mod(t,0.166))'

echo "sfx written to $OUT"
