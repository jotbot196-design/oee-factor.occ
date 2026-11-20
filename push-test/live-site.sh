#!/bin/bash
H=$(curl -sS https://oee-web.sasatornua.workers.dev/)
echo "$H" | grep -oE '<script[^>]*src="[^"]+"' | head
for f in $(echo "$H" | grep -oE 'src="[^"]+\.js[^"]*"' | cut -d'"' -f2); do
  echo "== $f"; curl -sS "https://oee-web.sasatornua.workers.dev/${f#/}" | grep -oE 'API_BASE *= *"[^"]+"|MTN_PATH *= *[^;]+' | head -3
done
echo "== inline:"; echo "$H" | grep -oE 'API_BASE *= *"[^"]+"|MTN_PATH *= *[^;]+' | head -3
