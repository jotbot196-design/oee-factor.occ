#!/bin/bash
H=$(curl -sS https://oee-web.sasatornua.workers.dev/)
echo "size: ${#H}"; echo "$H" | md5sum
echo "== push/sw hints:"; echo "$H" | grep -noE 'serviceWorker[^;]{0,80}|pushManager[^;]{0,80}|subscribe[^;]{0,80}|vapid[^;]{0,80}|/api/[a-z-]+' | sort -u | head -40
echo "== mtnSend handler:"; echo "$H" | grep -n "mtnSend').addEventListener" -A12 | cut -c1-400
echo "== saveMtn:"; echo "$H" | grep -noE 'async function saveMtn[^}]*}' | head
for p in sw.js service-worker.js manifest.json manifest.webmanifest; do echo "== /$p: $(curl -s -o /dev/null -w '%{http_code}' https://oee-web.sasatornua.workers.dev/$p)"; done
curl -sS https://oee-web.sasatornua.workers.dev/sw.js | head -c 3000
