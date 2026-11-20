#!/bin/bash
H=$(curl -sS https://oee-web.sasatornua.workers.dev/)
echo "== die-maint paths:"; echo "$H" | grep -noE "(const|let) DM_[A-Z_]+ *= *[^;]+|die-maint[a-z-]*" | sort -u | head -30
echo "== push block:"; echo "$H" | sed -n '38760,38800p' | cut -c1-300
echo "== pending:"; curl -sS https://oee.sasatornua.workers.dev/api/push/pending | head -c 1500; echo
echo "== dm save fn:"; echo "$H" | grep -nE "function dm[A-Za-z]*(Save|save|Send|Report|Submit)|dmSave|dmReport" | head -10 | cut -c1-300
