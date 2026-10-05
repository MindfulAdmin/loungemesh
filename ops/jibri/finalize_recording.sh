#!/usr/bin/env bash
# Jibri finalize hook: rename finished mp4 to RoomName_YYYY-MM-DD_HHmm.mp4
# Timestamp is UTC (date -u) so recordings-ui can parse filename stamps as UTC.
set -euo pipefail

RECORDINGS_DIR="${RECORDINGS_DIR:-/storage/recordings}"

# Jibri passes the recording directory as $1 on some images; also scan newest dirs.
TARGET="${1:-}"

rename_in_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local meta="$dir/metadata.json"
  local room="Recording"
  if [[ -f "$meta" ]]; then
    room=$(python3 - "$meta" <<'PY'
import json, re, sys
from urllib.parse import urlparse, unquote
meta_path = sys.argv[1]
try:
    m = json.load(open(meta_path))
    path = urlparse(m.get("meeting_url", "")).path.strip("/")
    slug = unquote(path.split("/")[-1] if path else "Recording")
    slug = re.sub(r"[-_]+", " ", slug).strip().lower()
    slug = re.sub(r"([a-z])and([a-z])", r"\1 and \2", slug)
    words = slug.split()
    title = (
        " ".join((w if (w == "and" and i) else w[:1].upper() + w[1:]) for i, w in enumerate(words))
        if words
        else "Recording"
    )
    safe = re.sub(r"[^\w\s-]+", "", title).strip().replace(" ", "-") or "Recording"
    print(safe)
except Exception:
    print("Recording")
PY
)
  fi
  local stamp
  stamp=$(date -u +%Y-%m-%d_%H%M)
  local mp4
  for mp4 in "$dir"/*.mp4; do
    [[ -f "$mp4" ]] || continue
    local base
    base=$(basename "$mp4")
    # skip if already nicely named Room_YYYY-MM-DD_HHMM.mp4
    if [[ "$base" =~ ^[A-Za-z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.mp4$ ]]; then
      continue
    fi
    local dest="$dir/${room}_${stamp}.mp4"
    if [[ -e "$dest" ]]; then
      dest="$dir/${room}_${stamp}_$$.mp4"
    fi
    mv -n "$mp4" "$dest" || true
    echo "finalize: renamed $base -> $(basename "$dest")"
  done
}

if [[ -n "$TARGET" && -d "$TARGET" ]]; then
  rename_in_dir "$TARGET"
else
  # Fallback: newest session folder
  newest=$(ls -1dt "$RECORDINGS_DIR"/*/ 2>/dev/null | head -1 || true)
  [[ -n "$newest" ]] && rename_in_dir "$newest"
fi
