#!/usr/bin/env bash
# Transcribe a recording with local Whisper.
#
# Usage: ./transcribe.sh [file.webm] [model]
#        no file  -> newest file in ~/Downloads/tab-audio
#        model    -> mlx repo id, or tiny|base|small|medium|large-v3 for plain whisper
#
# A file whose name ends in -2ch has two speakers on two channels:
#   LEFT  = the tab (them)      RIGHT = your microphone (you)
# Those are transcribed separately and merged into one labelled transcript,
# so you can see who said what.
set -euo pipefail

FILE="${1:-}"
MODEL="${2:-}"
DIR="$HOME/Downloads/tab-audio"

if [ -z "$FILE" ]; then
  FILE=$(ls -t "$DIR"/*.webm 2>/dev/null | head -1 || true)
  [ -z "$FILE" ] && { echo "No .webm found in $DIR"; exit 1; }
fi
[ -f "$FILE" ] || { echo "Not found: $FILE"; exit 1; }

BASE="${FILE%.*}"
OUTDIR="$(dirname "$FILE")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- pick an engine -----------------------------------------------------------
# mlx_whisper is far faster on Apple silicon. Plain whisper is the fallback.
if command -v mlx_whisper >/dev/null 2>&1; then
  ENGINE=mlx
  MODEL="${MODEL:-mlx-community/whisper-large-v3-turbo}"
elif command -v whisper >/dev/null 2>&1; then
  ENGINE=openai
  MODEL="${MODEL:-small}"
else
  echo "Neither mlx_whisper nor whisper is installed."; exit 1
fi

# Whisper loops on quiet audio when it is fed its own previous output.
# Turning that off is what stops a 80-minute meeting becoming 4000 lines of "Yeah."
run_whisper() {   # $1 = wav, $2 = output dir, $3 = output format
  if [ "$ENGINE" = mlx ]; then
    mlx_whisper "$1" --model "$MODEL" --language en \
      --condition-on-previous-text False \
      --output-dir "$2" --output-format "$3" --verbose False
  else
    whisper "$1" --model "$MODEL" --language en \
      --condition_on_previous_text False \
      --output_dir "$2" --output_format "$3" --verbose False
  fi
}

# A collapsed transcript is mostly one repeated line. Catch it and say so.
check_sane() {   # $1 = txt file, $2 = label
  local total uniq pct
  total=$(grep -c . "$1" || true)
  [ "${total:-0}" -lt 20 ] && return 0
  uniq=$(sort -u "$1" | grep -c . || true)
  pct=$(( uniq * 100 / total ))
  if [ "$pct" -lt 20 ]; then
    echo "  WARNING: $2 looks collapsed — only ${pct}% of lines are unique."
    echo "           Check the audio level, or try a larger model."
  fi
}

# A channel with no speech makes Whisper invent filler like "Thank you".
# Measure it first and skip it rather than write fiction into the transcript.
is_silent() {   # $1 = wav
  local mv
  mv=$(ffmpeg -hide_banner -i "$1" -af volumedetect -f null /dev/null 2>&1 \
        | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p' | head -1)
  [ -z "$mv" ] && return 1
  awk -v v="$mv" 'BEGIN { exit !(v < -60) }'
}

echo "Engine: $ENGINE   Model: $MODEL"

# --- single channel -----------------------------------------------------------
case "$BASE" in
  *-2ch) TWO_CH=1 ;;
  *)     TWO_CH=0 ;;
esac

if [ "$TWO_CH" = 0 ]; then
  echo "1/2 Converting to 16 kHz mono"
  ffmpeg -y -loglevel error -i "$FILE" -ac 1 -ar 16000 -c:a pcm_s16le "$TMP/a.wav"
  echo "2/2 Transcribing"
  run_whisper "$TMP/a.wav" "$TMP" txt
  mv "$TMP/a.txt" "$BASE.txt"
  check_sane "$BASE.txt" "transcript"
  echo "Done: $BASE.txt"
  exit 0
fi

# --- two channels: them on the left, you on the right -------------------------
echo "1/3 Splitting the two channels"
ffmpeg -y -loglevel error -i "$FILE" \
  -filter_complex "[0:a]channelsplit=channel_layout=stereo[L][R]" \
  -map "[L]" -ac 1 -ar 16000 -c:a pcm_s16le "$TMP/them.wav" \
  -map "[R]" -ac 1 -ar 16000 -c:a pcm_s16le "$TMP/me.wav"

echo "2/3 Transcribing both channels"
for ch in them me; do
  if is_silent "$TMP/$ch.wav"; then
    echo "  $ch: silent, skipping (nothing was recorded on that channel)"
    printf 'start\tend\ttext\n' > "$TMP/$ch.tsv"
    : > "$TMP/$ch.txt"
  else
    run_whisper "$TMP/$ch.wav" "$TMP" all
  fi
done

echo "3/3 Merging into one labelled transcript"

# Written by the extension on a Google Meet call, when live captions were on.
# It turns THEM into the real names of the people who spoke.
SPEAKERS="${BASE}-speakers.json"
[ -f "$SPEAKERS" ] || SPEAKERS=""
[ -n "$SPEAKERS" ] && echo "  using speaker names from $(basename "$SPEAKERS")"

python3 - "$TMP/them.tsv" "$TMP/me.tsv" "$BASE.txt" "$SPEAKERS" <<'PY'
import sys, csv, json, os

def read(path, who):
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        r = csv.reader(f, delimiter='\t')
        next(r, None)                       # header: start, end, text
        for row in r:
            if len(row) < 3:
                continue
            text = row[2].strip()
            if not text:
                continue
            rows.append((int(row[0]), who, text))
    return rows

them_tsv, me_tsv, out = sys.argv[1], sys.argv[2], sys.argv[3]
speakers_path = sys.argv[4] if len(sys.argv) > 4 else ''

# Segments look like {"t": 12040, "name": "Priya Sharma"}, t in ms from the start.
segments = []
if speakers_path and os.path.exists(speakers_path):
    with open(speakers_path, encoding='utf-8') as f:
        segments = sorted(json.load(f).get('segments', []), key=lambda s: s['t'])

# Captions appear a moment AFTER the words are said, so look slightly ahead too.
LEAD_MS = 2000

def speaker_at(ms):
    """The last person Meet showed as speaking at this point in the recording."""
    name = ''
    for seg in segments:
        if seg['t'] <= ms + LEAD_MS:
            name = seg['name']
        else:
            break
    return name.upper() if name else ''

lines = read(them_tsv, 'THEM') + read(me_tsv, 'ME')

if segments:
    named = []
    for ms, who, text in lines:
        if who == 'THEM':
            who = speaker_at(ms) or 'THEM'   # fall back when nobody was captioned
        named.append((ms, who, text))
    lines = named

lines.sort(key=lambda x: x[0])

def stamp(ms):
    s = ms // 1000
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"

with open(out, 'w', encoding='utf-8') as f:
    last = None
    for ms, who, text in lines:
        if who != last:                     # blank line when the speaker changes
            f.write('\n')
            last = who
        f.write(f"[{stamp(ms)}] {who}: {text}\n")

print(f"  {len(lines)} lines written")
PY

# Keep the single-speaker transcripts as well - useful for reviewing only yourself.
cp "$TMP/me.txt"   "${BASE}-me.txt"   2>/dev/null || true
cp "$TMP/them.txt" "${BASE}-them.txt" 2>/dev/null || true

check_sane "$BASE.txt" "merged transcript"
echo "Done:"
echo "  $BASE.txt        both speakers, labelled and in order"
[ -f "${BASE}-me.txt" ] && echo "  ${BASE}-me.txt   only you"
exit 0
