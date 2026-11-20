#!/bin/bash
H=$(curl -sS https://oee-web.sasatornua.workers.dev/)
echo "$H" | sed -n '38668,38680p;38728,38762p' | cut -c1-500
