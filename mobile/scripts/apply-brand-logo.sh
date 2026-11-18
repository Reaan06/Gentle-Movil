#!/usr/bin/env bash
# Apply the Gentle-Movil brand logo to the app's icons and splash.
# Source: a high-res PNG passed as $1 (elephant + rose + neon ring).
#
# Android adaptive icons need the artwork inside a safe zone (~66% center circle,
# the rest can be masked away by the launcher), so the logo is centered on a
# solid background and scaled down before generating the layers.
set -euo pipefail

SRC="${1:?usage: apply-brand-logo.sh <logo.png>}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # mobile/

MAGICK="$(command -v magick || command -v convert)"

# Square, transparent-safe source inspection
"$MAGICK" identify "$SRC" | head -1

# 1. Main app icon (1024) — full artwork on brand black
"$MAGICK" "$SRC" -resize 1024x1024 -gravity center -background '#060407' \
  -extent 1024x1024 assets/icon.png

# 2. Favicon (48, RGBA)
"$MAGICK" "$SRC" -resize 48x48 -gravity center -background none \
  -extent 48x48 assets/favicon.png

# 3. Splash icon (400, transparent background) — the elephant art floats on splash
"$MAGICK" "$SRC" -resize 400x400 -gravity center -background none \
  -extent 400x400 assets/splash-icon.png

# 4. Android adaptive icon: foreground (artwork shrunk into the safe zone, 1024)
#    + background (solid brand color 1024) + monochrome (alpha silhouette, 1024)
"$MAGICK" "$SRC" -resize 640x640 -gravity center -background none \
  -extent 1024x1024 assets/android-icon-foreground.png
"$MAGICK" -size 1024x1024 xc:'#060407' assets/android-icon-background.png
"$MAGICK" "$SRC" -resize 640x640 -gravity center -background none -extent 1024x1024 \
  -colorspace gray -threshold 50% -negate assets/android-icon-monochrome.png

# 5. Splash background color in app.json must match the brand black
echo "done — icon, favicon, splash-icon, adaptive layers written"
