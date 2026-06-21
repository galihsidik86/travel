#!/usr/bin/env bash
# Fetch Quranic-verse doa MP3 from everyayah.com.
#
# Hanya 2 dari 10 doa di shared/doa-harian.js yang merupakan ayat
# Al-Quran langsung — keduanya QS Al-Baqarah 2:201 ("Rabbana atina fid
# dunya hasanah..."). Sisanya hadith/athar yang butuh commissioned
# recording terpisah.
#
# Source: Mishary Rashid Alafasy via everyayah.com — widely redistributed
# di Islamic apps; license tidak eksplisit CC tapi defensible untuk
# non-commercial educational use dengan attribution.
#
# Usage:
#   bash scripts/fetch-quranic-doa-mp3.sh             # idempotent, skip if exists
#   bash scripts/fetch-quranic-doa-mp3.sh --force     # redownload
#
# Run dari root project (where shared/ folder exists).

set -euo pipefail

DEST_DIR="shared/audio/doa"
RECITER="Alafasy_128kbps"
BASE="https://everyayah.com/data/${RECITER}"
FORCE=false

if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

if [[ ! -d "$DEST_DIR" ]]; then
  echo "✗ $DEST_DIR not found — run dari root project."
  exit 1
fi

# Map: filename → ayah URL. Pattern di everyayah.com: 6-digit gabungan
# 3-digit surah + 3-digit verse, NO separator (mis. 002201.mp3 = QS 2:201).
declare -A FILES=(
  ["sapu-jagat.mp3"]="002201.mp3"
  ["antara-rukun-yamani.mp3"]="002201.mp3"
)

downloaded=0
skipped=0
failed=0

for fname in "${!FILES[@]}"; do
  dest="$DEST_DIR/$fname"
  src="$BASE/${FILES[$fname]}"
  if [[ -f "$dest" && "$FORCE" == "false" ]]; then
    echo "⏭  $fname (already exists, --force to redownload)"
    skipped=$((skipped+1))
    continue
  fi
  echo "⇣  $fname ← $src"
  if curl -fsSL "$src" -o "$dest"; then
    size=$(wc -c < "$dest")
    echo "   ✓ $size bytes"
    downloaded=$((downloaded+1))
  else
    echo "   ✗ download gagal"
    failed=$((failed+1))
    rm -f "$dest"
  fi
done

echo ""
echo "Summary: $downloaded downloaded, $skipped skipped, $failed failed."
echo "Attribution: Mishary Rashid Alafasy via everyayah.com"
echo ""
echo "Sisanya (8 doa hadith/athar) butuh commissioned recording."
echo "Drop file manual ke $DEST_DIR/ dengan nama sesuai shared/audio/doa/README.md"
