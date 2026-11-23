#!/bin/zsh
# Fit every PNG in store/screens-raw to 1280x800 (scaled to fit, padded white) -> store/screens/.
cd "${0:A:h}" && mkdir -p screens
for f in screens-raw/*.png(N); do
  out="screens/${f:t:r}-1280x800.png"
  cp "$f" "$out" >/dev/null
  w=$(sips -g pixelWidth "$out" | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$out" | awk '/pixelHeight/{print $2}')
  if (( w * 800 > h * 1280 )); then sips --resampleWidth 1280 "$out" >/dev/null; else sips --resampleHeight 800 "$out" >/dev/null; fi
  sips --padToHeightWidth 800 1280 --padColor FFFFFF "$out" >/dev/null
  sips -s format png "$out" >/dev/null; echo "$out" >/dev/null
done
