#!/bin/zsh
# Build queue.zip for kamphey.com: one folder "queue-extension" inside, ready for Load unpacked.
set -e
cd "${0:A:h}/.."
out="${1:-$HOME/Desktop/WORKSPACE/kamphey.com/site/queue/queue.zip}"
tmp=$(mktemp -d)
mkdir "$tmp/queue-extension"
cp -R extension/. "$tmp/queue-extension/"
rm -f "$tmp/queue-extension/icons/icon.svg"
rm -f "$out"
(cd "$tmp" && zip -qrX "$out" queue-extension -x '*/.*')
echo "$out ($(grep '"version"' extension/manifest.json | tr -d ' ,'))"
