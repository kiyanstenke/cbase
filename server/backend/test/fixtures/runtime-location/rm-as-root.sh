#!/bin/sh
# `rm` in the project container, as root (runtime-location.test.js): root does not care about missing write permissions. The fake
# docker (fake-docker.mjs, `programs`) runs this script instead of `rm`: first the permissions back, then the real rm.
# Called like `rm -rf <path>`.
target=""
for a in "$@"; do target="$a"; done
[ -n "$target" ] && chmod -R u+w "$target" 2>/dev/null
exec rm "$@"
