#!/bin/bash
H=$(curl -sS https://oee-web.sasatornua.workers.dev/)
echo "== แจ้งซ่อม occurrences:"; echo "$H" | grep -no "[^'\"<>]\{0,60\}แจ้งซ่อม[^'\"<>]\{0,60\}" | head -60
echo "== push calls:"; echo "$H" | grep -no "api/push/[a-z]*" | sort -u
echo "== dmPushPing callers:"; echo "$H" | grep -no ".\{0,160\}dmPushPing(.\{0,80\}" | head
echo "== apiHeaders:"; echo "$H" | grep -no "function apiHeaders[^}]*}" | head -2
echo "== sw push text:"; curl -sS https://oee-web.sasatornua.workers.dev/sw.js | grep -n "showNotification" 
