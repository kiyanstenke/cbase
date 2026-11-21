#!/bin/bash
# Container entry of the per-user backend.
# In Sysbox operation (CBASE_DIND=1, start as root) an INNER Docker daemon runs — so user projects can start arbitrary containers
# without touching the host. Afterwards the backend is always run as the unprivileged user `agent`.
#
# As root before `setpriv`, in this order:
#   1. Remove leftovers of the previous start — including the network-separation marker (see 2).
#   2. Separation of the project networks: the INPUT allow list for the `cbp-*` bridges BEFORE dockerd, so that a project container
#      with `unless-stopped` does not start in an open window. If it succeeds, it writes the marker /run/cbase/network-separation.ok
#      with the start time of PID 1 of this container start; the backend accepts the marker only if it matches the running PID 1
#      (projectbox/network-marker.js), and without it creates and starts no project container. If it fails — OR it stands but the
#      marker cannot be written (then the same holds for the backend as without separation) —, dockerd starts anyway (the stacks of
#      unconverted projects need it), and a background step stops every container with label `cbase.project` as soon as the daemon
#      answers — its `unless-stopped` would otherwise run past the backend. The window until this stop stays open.
#   3. dockerd.
#   4. /etc/hosts writable for agent (the names `<project>.cbase`).
#   5. Shared login: `.credentials.json` moves from ~/.claude/ into the login directory that CLAUDE_SECURESTORAGE_CONFIG_DIR (image
#      ENV) makes every CLI start point to. Runs WITHOUT the DIND condition: the variable is in EVERY container of this image, a B
#      without Sysbox would otherwise no longer find the login.
# Every step is encapsulated: an error reports on stderr and never takes the backend down. CAUTION when changing: in a function called
# behind `if`/`||`, `set -e` does NOT take effect — so there every command that matters carries its own `|| return 1`.
#
# Test seam: CBASE_ENTRY_ROOT prefixes /etc/hosts, /run, /var/run, /var/log and /proc/1/stat (like the clock seam; empty = real).
# Guard: tools/check/entry-sh.test.mjs. Only what bash 3.2 (gate, macOS), bash 5.2 and dash can do.
set -e

W="${CBASE_ENTRY_ROOT:-}"
NETWORK_MARKER="$W/run/cbase/network-separation.ok"
# The "B ends" marker the gateway sets via `docker exec -u root` before its exec stop of the project containers
# (server/gateway/containers.js stopProjectContainer; read by runs/server-end.js serverEnds). It belongs to ONE life of B: every
# start removes it (the container file system survives `docker start`), otherwise serverEnds() would stay wrong-true for up to ten
# minutes and the observer (projectbox/resumption.js) would hand over a real end of a project container.
B_ENDS_MARKER="$W/run/cbase/b-ends"

# Start time of PID 1 (field 22 of /proc/1/stat, counted after the LAST closing parenthesis — the command name may carry parentheses and spaces).
# The same computation as projectbox/network-marker.js:startTimeFromStat.
pid1_start() {
  p1_stat=$(cat "$W/proc/1/stat") || return 1
  p1_rest=${p1_stat##*)}
  p1_start=$(printf '%s\n' "$p1_rest" | awk '{print $20}')
  [ -n "$p1_start" ] || return 1
  printf '%s\n' "$p1_start"
}

# Step 2. Exactly this list and never `br-+` (that would cut the stacks of unconverted projects off from their docker-proxy
# ports); UDP and IPv6 stay untouched until the acceptance measures them (DNS). `cbp-+` also applies without an existing
# bridge. The jump stands exactly once (`-C` before `-I`). `cbp-` is the ONE prefix of projectbox/creation.js BRIDGE_PREFIX (the
# guard tools/check/entry-sh.test.mjs binds the two).
network_separation() {
  { iptables -N CBASE-PROJ 2>/dev/null || iptables -F CBASE-PROJ; } || return 1
  iptables -A CBASE-PROJ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || return 1
  iptables -A CBASE-PROJ -p tcp --dport 7718 -j ACCEPT || return 1
  iptables -A CBASE-PROJ -p tcp -j REJECT --reject-with tcp-reset || return 1
  iptables -C INPUT -i cbp-+ -j CBASE-PROJ 2>/dev/null || iptables -I INPUT -i cbp-+ -j CBASE-PROJ || return 1
}

network_marker_write() {
  nm_start=$(pid1_start) || return 1
  mkdir -p "$W/run/cbase" || return 1
  chmod 755 "$W/run/cbase" || return 1
  printf '%s\n' "$nm_start" > "$NETWORK_MARKER.fresh" || return 1
  chmod 644 "$NETWORK_MARKER.fresh" || return 1
  mv "$NETWORK_MARKER.fresh" "$NETWORK_MARKER" || return 1
}

# Without separation: stop every project container as soon as dockerd answers. Forked twice so that the step hangs on PID 1 (tini)
# and not as a zombie on the backend, which takes this shell's place by exec right away. Cap: 120 attempts at one-second intervals,
# with a message. Before that, thaw every PAUSED one by label — a paused container does not accept TERM; a failed unpause does
# not stop the stop.
project_container_stop() {
  (
    (
      ps_i=0
      until docker info >/dev/null 2>&1; do
        ps_i=$((ps_i + 1))
        if [ "$ps_i" -ge 120 ]; then
          echo "[entry] dockerd does not answer after 120 attempts — project containers NOT stopped (cap)" >&2
          exit 0
        fi
        sleep 1
      done
      ps_paused=$(docker ps -q --filter label=cbase.project --filter status=paused) || ps_paused=""
      if [ -n "$ps_paused" ]; then
        # shellcheck disable=SC2086 — the ids should arrive one by one
        docker unpause $ps_paused >&2 || echo "[entry] docker unpause of the project containers failed" >&2
      fi
      ps_ids=$(docker ps -q --filter label=cbase.project) || exit 0
      if [ -n "$ps_ids" ]; then
        echo "[entry] without network separation: project containers are being stopped" >&2
        # shellcheck disable=SC2086 — the ids should arrive one by one
        docker stop -t 30 $ps_ids >&2 || echo "[entry] docker stop of the project containers failed" >&2
      fi
    ) &
  )
}

# Step 5. As root on agent's home: never act through a symlink (a link agent creates must not make root move, read or overwrite
# something foreign) and never move onto an existing name (`mv` follows a target that is a link to a directory). The entries
# themselves — file OR link — are only renamed, never read; a moved link is resolved by the CLI as agent only later and replaced
# by a file of its own at the next write. Rules:
#   only old         ⇒ `mv` in (same file system: atomic)
#   both             ⇒ the newer stays (on a tie the one in the login directory), the other is set aside with a timestamp
#                      in the login directory (0700, never under the name the CLI reads)
#   only new, none   ⇒ nothing
#   second start     ⇒ no effect
# Afterwards owner agent and 0600 for the file in the login directory — a run as root (docker exec -u 0 … claude) would otherwise
# create it root-owned, and agent would be logged out. Only for a file of its own with exactly one link.
login_aside() {
  lb_ts=$(date -u +%Y%m%dT%H%M%SZ) || return 1
  lb_name="$1/.credentials.json.aside-$lb_ts-$2"
  if [ -e "$lb_name" ] || [ -L "$lb_name" ]; then lb_name="$lb_name-$$"; fi
  printf '%s\n' "$lb_name"
}

login_relocation() {
  lu_target="${CLAUDE_SECURESTORAGE_CONFIG_DIR:-}"
  [ -n "$lu_target" ] || return 0
  lu_old_dir="$HOME/.claude"
  lu_old="$lu_old_dir/.credentials.json"
  lu_new="$lu_target/.credentials.json"
  if [ -L "$lu_target" ] || { [ -e "$lu_target" ] && [ ! -d "$lu_target" ]; }; then
    echo "[entry] $lu_target is not a directory (or is a symlink) — login not touched" >&2
    return 1
  fi
  mkdir -p "$lu_target" || return 1
  chown -h agent:agent "$lu_target" || return 1
  chmod 700 "$lu_target" || return 1
  if [ -L "$lu_old_dir" ]; then
    echo "[entry] $lu_old_dir is a symlink — old login location not touched" >&2
  elif [ -e "$lu_old" ] || [ -L "$lu_old" ]; then
    if [ -d "$lu_old" ] && [ ! -L "$lu_old" ]; then
      echo "[entry] $lu_old is a directory — not touched" >&2
    elif [ -e "$lu_new" ] || [ -L "$lu_new" ]; then
      if [ "$lu_old" -nt "$lu_new" ]; then
        lu_way=$(login_aside "$lu_target" login) || return 1
        mv "$lu_new" "$lu_way" || return 1
        mv "$lu_old" "$lu_new" || return 1
        echo "[entry] Login: both locations occupied, ~/.claude is newer — the one from the login directory lies at $lu_way" >&2
      else
        lu_way=$(login_aside "$lu_target" claude) || return 1
        mv "$lu_old" "$lu_way" || return 1
        echo "[entry] Login: both locations occupied, the login directory is newer — the one from ~/.claude lies at $lu_way" >&2
      fi
    else
      mv "$lu_old" "$lu_new" || return 1
      echo "[entry] Login: ~/.claude/.credentials.json → $lu_new" >&2
    fi
  fi
  if [ -f "$lu_new" ] && [ ! -L "$lu_new" ]; then
    if [ -n "$(find "$lu_new" -prune -links +1)" ]; then
      echo "[entry] $lu_new has several hard links — owner not touched" >&2
      return 1
    fi
    chown -h agent:agent "$lu_new" || return 1
    chmod 600 "$lu_new" || return 1
  fi
}

if [ "${CBASE_DIND:-0}" = "1" ] && [ "$(id -u)" = "0" ]; then
  # The data root is the default path /var/lib/docker — the gateway mounts a volume OF ITS OWN per user there, so pulled images
  # still survive container re-creation.
  # Why not in the home volume any more? The home volume is mounted via shiftfs; on it the kernel refuses every overlay mount and
  # dockerd falls back SILENTLY to `vfs`. vfs has no layer sharing: 11.5 GB of images measured as 76 GB of disk.
  # And it has to be exactly this path — Sysbox sets up only /var/lib/docker overlay-capable; on another ext4 volume dockerd ends
  # up at vfs again (both tested).
  # If the volume is missing, Sysbox uses its own directory: it works, but the images are lost at the next re-creation of the
  # container.
  # Clean up stale PID/socket leftovers: after `docker restart` (container FS stays!) the hard-killed dockerd leaves its pid file
  # → "pid file found" → dockerd never starts again.
  # The network-separation marker for the same reason: without this `rm`, the marker of the previous start would stand after a later
  # failure of step 2.
  rm -f "$W/var/run/docker.pid" "$W/run/docker/containerd/containerd.pid" "$W/var/run/docker.sock" "$NETWORK_MARKER" "$NETWORK_MARKER.fresh" "$B_ENDS_MARKER" "$B_ENDS_MARKER.fresh"
  if network_separation; then
    # Without the marker the backend starts no project container (projectbox/network-marker.js) — the inner dockerd would bring
    # back those with `unless-stopped`, bypassing the backend. So the same stop as without separation.
    network_marker_write || {
      echo "[entry] network separation stands, but the marker $NETWORK_MARKER is missing — no project containers in this start" >&2
      project_container_stop
    }
  else
    echo "[entry] network separation (iptables CBASE-PROJ) failed — no project containers in this start" >&2
    project_container_stop
  fi
  dockerd >"$W/var/log/dockerd.log" 2>&1 &
  { chgrp agent "$W/etc/hosts" && chmod g+w "$W/etc/hosts"; } || echo "[entry] /etc/hosts not writable" >&2
fi

if [ "$(id -u)" = "0" ]; then
  login_relocation || echo "[entry] login relocation incomplete — the login stays where it is" >&2
  # With the variable SET the CLI reads only the login directory, never ~/.claude. If the login stayed at the old location (early
  # abort above, ~/.claude as a symlink), every `claude` start would be logged out, while the usage ring kept showing values via the
  # second candidate in usage.js. Empty means ~/.claude for the CLI — the backend and everything it starts inherits the empty
  # value; only a direct `docker exec` still carries the image's value.
  if [ -n "${CLAUDE_SECURESTORAGE_CONFIG_DIR:-}" ] && [ ! -e "$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json" ] \
    && [ -e "$HOME/.claude/.credentials.json" ]; then
    echo "[entry] Login stays in ~/.claude — CLAUDE_SECURESTORAGE_CONFIG_DIR cleared for this start" >&2
    export CLAUDE_SECURESTORAGE_CONFIG_DIR=
  fi
fi

# HOME=/home/agent comes from the image ENV; --init-groups takes the docker group along.
exec setpriv --reuid=agent --regid=agent --init-groups node /app/headless.js
