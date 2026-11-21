#!/bin/bash
# Entrypoint of the project container `cbase-p-<project>` (image `cbase-projectbox`, in the image as
# /usr/sbin/cbase-projectbox-entry behind tini: ENTRYPOINT ["/usr/bin/tini","--","/usr/sbin/cbase-projectbox-entry"]).
#
# As root, in this order:
#   1. CBASE_DOCKER_POOL (CIDR) missing or not a CIDR ⇒ abort, no dockerd.
#   2. Nest cgroup v2 like docker:dind: own processes to /sys/fs/cgroup/init, then every controller into cgroup.subtree_control.
#      Without it the inner dockerd may not delegate memory and io to the stack (`docker stats` showed 0 B, a `-m` limit had no
#      effect — measured). NEVER FATAL: if a new process lands in the root between the move to init and the write (e.g. the
#      `docker exec … docker info` of the start probe right after `run -d`), the kernel answers EBUSY — the script used to die of
#      it under `set -e`, BEFORE dockerd, and the status file stayed at `phase=start`. Now: move and write up to CG_ATTEMPTS (5)
#      times; if it still fails, `phase=error` stands with `notice=cgroup: …`, and THIS notice stays to the end (every later phase
#      except `ended` becomes it — without delegation no limit works, "ready" would be a lie). dockerd starts anyway: the container
#      keeps running (otherwise an `unless-stopped` loop), and project creation reads `error` at once.
#   3. Remove leftovers of a hard end (pid files, socket) like entry.sh — otherwise "pid file found", and dockerd never starts
#      again; plus the status file of the previous start.
#  3a. ONLY in a copy (dormant as long as there is no copy): if /cbase-copy/overlays.tsv is there, the script mounts the copy's
#      overlays BEFORE dockerd. Without the file nothing happens here, no call — the same steps as before (guard: the call order
#      against the fixed state BEFORE_ST2_0 in the test).
#        - Lines `target<TAB>lower<TAB>upper<TAB>work`, absolute paths; sorted (C locale, whole line) so that every target is
#          mounted BEFORE the targets below it (outer before inner), whatever order the file names them in. A line with another
#          field count, a relative path, a duplicate target, a `,` `\` `"` in a layer or a `:` in `lower` (lowerdir separates
#          layers there) is an error, as is a file without a line — the whole file is checked BEFORE anything is mounted; never
#          go on without an overlay.
#        - Per line: `mountpoint -q target` ⇒ WHAT hangs there is told by the last line of the target in /proc/self/mountinfo:
#          exactly this overlay (type `overlay`, `lowerdir`/`upperdir` as in the line) ⇒ already mounted, go on; anything else (a
#          bind from the Docker configuration, another overlay, no entry) ⇒ error — a target with something else on it would
#          otherwise go on without the overlay (each container start has a fresh mount namespace: an overlay from an earlier run
#          can never stand there, so a mount point is a misconfiguration). Otherwise `mkdir -p target` and
#          `LIBMOUNT_FORCE_MOUNT2=always mount -t overlay overlay -o userxattr,lowerdir=…,upperdir=…,workdir=… target`, no further
#          option (only through mount(2); the variable is also set in the image).
#        - If /cbase-copy/.prepared is missing: `phase=prepare`, wait until the file is there (B prepares the copy through the
#          mounted overlays). Loop until the event at the tick CBASE_PROJECTBOX_TICK; cap CBASE_PROJECTBOX_PREPARE_S (3600 s) with a
#          message.
#        - Then the raw roots go: EVERY mount point at or below /cbase-copy and /cbase-main (from /proc/self/mountinfo, inner
#          before outer) with `umount -l` — the overlays hold their layers, no process of the copy sees the raw layer or the main
#          instance. Afterwards nothing may be mounted there any more (second reading), otherwise an error. Not literally
#          `umount -l /cbase-main`: the main instance lies under /cbase-main<orig>, /cbase-main itself is then no mount point, and
#          a bare `umount` would fail.
#        - If any of this fails: `phase=error`, `notice=overlay: <target> — …` (or `prepare: …`, `unmount: …`), NO dockerd, and the
#          script lives on until TERM/INT comes (then exit 143/130) — never `exit` (step 8: otherwise an `unless-stopped` loop),
#          never go on without an overlay: a failed mount never starts a stack.
#   4. /etc/docker/daemon.json at EVERY start: `default-address-pools` {base: $CBASE_DOCKER_POOL, size: 24} and the log rotation
#      (100 MB × 5 per container — no disk limit is set otherwise).
#   5. `dockerd &` — this script stays its parent process (no `exec dockerd`: DNAT comes AFTER dockerd, and a background helper would
#      become a zombie); `trap` passes TERM and INT on to dockerd as TERM (a background process of a non-interactive shell starts
#      with SIGINT ignored — a passed-on INT would fizzle).
#   6. Wait until `docker info` answers: loop until the event; cap CBASE_PROJECTBOX_ATTEMPTS (120) attempts at the tick
#      CBASE_PROJECTBOX_TICK (1 s). At the cap: status `error`, NO DNAT, but no end either — an exit would put `--restart
#      unless-stopped` into a restart loop. If dockerd ends earlier, the script ends with its code.
#   7. DNAT: route_localnet for all, eth0, docker0; OUTPUT 127.0.0.1:7718 → gateway of the project network:7718 plus MASQUERADE;
#      then — only if the jump `PREROUTING -m addrtype --dst-type LOCAL -j DOCKER` of the inner dockerd stands (published ports of
#      the stack go to their container first) — with -A, so BEHIND it: own IP and docker0 address to 127.0.0.1. Switchable:
#        CBASE_DNAT_LIMIT=1 (default): own IP only with `-i eth0` (the backend, not the own stack);
#                                      docker0 only for ports below the start of ip_local_port_range (the browsers' CDP
#                                      and the inspector lie on ephemeral ports).
#        CBASE_DNAT_LIMIT=0 (the MEASURED form): both rules without -i and without a port limit.
#      Neither `-i eth0` nor the port limit is measured — if a project hits an ephemeral port, the acceptance shows it, and the
#      backend creates the container with 0.
#   8. An error in 2, 6 or 7 is NOT fatal: it stands in /run/cbase-projectbox.status (phase=error, notice=…), the container keeps
#      running (otherwise an `unless-stopped` loop). Otherwise phase=ready.
#   9. `wait` on dockerd; its exit code is the script's.
# No tmpfs over /tmp.
#
# Status file (0644, atomic): `phase=start|prepare|wait|ready|error|ended` and `notice=<one line>`.
#
# Test seams: CBASE_PROJECTBOX_ROOT prefixes /sys/fs/cgroup, /etc/docker, /run, /var/run, /cbase-copy, /cbase-main,
# /proc/self/mountinfo and EVERY path from overlays.tsv (empty = real; like CBASE_ENTRY_ROOT in entry.sh), plus the two numbers from 6
# and CBASE_MOUNT_BIN, CBASE_MOUNTPOINT_BIN, CBASE_UMOUNT_BIN (the programs of 3a). Guard: tools/check/projectbox-entry.test.mjs. Only
# what bash 3.2 (gate, macOS), bash 5.2 and dash can do. CAUTION when changing: in a function called behind `if`/`||`, `set -e` does NOT
# take effect — there every command that matters carries its own `|| return 1`.
set -eu

W="${CBASE_PROJECTBOX_ROOT:-}"
STATUS="$W/run/cbase-projectbox.status"
ATTEMPTS="${CBASE_PROJECTBOX_ATTEMPTS:-120}"
TICK="${CBASE_PROJECTBOX_TICK:-1}"
LIMIT="${CBASE_DNAT_LIMIT:-1}"
DOCKERD_PID=""
END=""
ERROR=""
NOTICE=""
CG_ERROR=""
CG_ATTEMPTS=5
# Step 3a.
MOUNT_BIN="${CBASE_MOUNT_BIN:-mount}"
MOUNTPOINT_BIN="${CBASE_MOUNTPOINT_BIN:-mountpoint}"
UMOUNT_BIN="${CBASE_UMOUNT_BIN:-umount}"
PREPARE_S="${CBASE_PROJECTBOX_PREPARE_S:-3600}"
COPY="$W/cbase-copy"
MAIN="$W/cbase-main"
OVERLAYS="$COPY/overlays.tsv"
PREPARED="$COPY/.prepared"
MOUNTINFO="$W/proc/self/mountinfo"
OV_ERROR=""
QUIET_PID=""
TAB=$(printf '\t')

log() { printf '[projectbox] %s\n' "$*" >&2; }

# Never fatal: a status file that cannot be written does not take the container down. A cgroup error (step 2) stays: every phase
# except `ended` becomes `error` with its notice.
status() {
  if [ -n "$CG_ERROR" ] && [ "$1" != ended ]; then set -- error "cgroup: $CG_ERROR"; fi
  { printf 'phase=%s\nnotice=%s\n' "$1" "$2" > "$STATUS.new" && chmod 644 "$STATUS.new" && mv -f "$STATUS.new" "$STATUS"; } \
    || log "status file $STATUS not written (phase=$1)"
}

# TERM and INT go to dockerd as TERM. Before its start: end at once.
passOn() {
  END=1
  if [ -n "$DOCKERD_PID" ]; then
    kill -TERM "$DOCKERD_PID" 2>/dev/null || :
  else
    [ -z "$QUIET_PID" ] || kill "$QUIET_PID" 2>/dev/null || :
    exit "$1"
  fi
}
trap 'passOn 143' TERM
trap 'passOn 130' INT

# A command for step 7: on error it stands with its output in ERROR (one line).
run() {
  if run_from=$("$@" 2>&1); then return 0; fi
  ERROR="$* — $(printf '%s' "$run_from" | tr '\n' ' ')"
  return 1
}

# Step 2. Called behind `if`, so without `set -e`: every command carries its own handling. The move (xargs) may fail (a process
# that no longer exists when it is moved, e.g. xargs itself); writing the controllers may not — after an EBUSY the next attempt
# takes the newcomer along to init.
cgroup_write() { sed -e 's/ / +/g' -e 's/^/+/' < "$CG/cgroup.controllers" > "$CG/cgroup.subtree_control"; }
cgroup_nest() {
  cg_out=$(mkdir -p "$CG/init" 2>&1) || { CG_ERROR="mkdir $CG/init — $(printf '%s' "$cg_out" | tr '\n' ' ')"; return 1; }
  cg_i=0
  while [ "$cg_i" -lt "$CG_ATTEMPTS" ]; do
    cg_i=$((cg_i + 1))
    xargs -rn1 < "$CG/cgroup.procs" > "$CG/init/cgroup.procs" 2>/dev/null || :
    if cg_out=$(cgroup_write 2>&1); then
      [ "$cg_i" -eq 1 ] || log "cgroup: subtree_control written on attempt $cg_i"
      return 0
    fi
  done
  CG_ERROR="subtree_control not written after $CG_ATTEMPTS attempts — $(printf '%s' "$cg_out" | tr '\n' ' ')"
  return 1
}

is_ipv4() { printf '%s\n' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }

# The first IPv4 of an interface, without prefix length. Runs in `$( )`, so in a subshell: on error the message goes to stdout (an
# ERROR= here would be lost with the subshell).
address_of() {
  av=$(ip -4 -o addr show dev "$1" 2>&1) || { printf 'ip -4 -o addr show dev %s — %s\n' "$1" "$(printf '%s' "$av" | tr '\n' ' ')"; return 1; }
  av=$(printf '%s\n' "$av" | awk '{ for (i = 1; i < NF; i++) if ($i == "inet") { split($(i + 1), a, "/"); print a[1]; exit } }')
  is_ipv4 "$av" || { printf 'no IPv4 on %s\n' "$1"; return 1; }
  printf '%s\n' "$av"
}

dnat() {
  for dn_if in all eth0 docker0; do
    run sysctl -w "net.ipv4.conf.$dn_if.route_localnet=1" || return 1
  done
  dn_ip=$(address_of eth0) || { ERROR="$dn_ip"; return 1; }
  dn_d0=$(address_of docker0) || { ERROR="$dn_d0"; return 1; }
  dn_gw=$(ip -4 route show default 2>&1) || { ERROR="ip -4 route show default — $dn_gw"; return 1; }
  dn_gw=$(printf '%s\n' "$dn_gw" | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }')
  is_ipv4 "$dn_gw" || { ERROR="no gateway (ip -4 route show default)"; return 1; }

  run iptables -t nat -A OUTPUT -d 127.0.0.1/32 -p tcp --dport 7718 -j DNAT --to-destination "$dn_gw:7718" || return 1
  run iptables -t nat -A POSTROUTING -s 127.0.0.1/32 -o eth0 -j MASQUERADE || return 1

  if ! run iptables -t nat -C PREROUTING -m addrtype --dst-type LOCAL -j DOCKER; then
    ERROR="the jump PREROUTING → DOCKER of the inner dockerd is missing, own IP and docker0 stay without DNAT ($ERROR)"
    return 1
  fi
  if [ "$LIMIT" = 0 ]; then
    run iptables -t nat -A PREROUTING -d "$dn_ip/32" -p tcp -j DNAT --to-destination 127.0.0.1 || return 1
    run iptables -t nat -A PREROUTING -d "$dn_d0/32" -p tcp -j DNAT --to-destination 127.0.0.1 || return 1
  else
    dn_eph=$(sysctl -n net.ipv4.ip_local_port_range 2>&1) || { ERROR="sysctl -n net.ipv4.ip_local_port_range — $dn_eph"; return 1; }
    dn_eph=$(printf '%s\n' "$dn_eph" | awk '{ print $1; exit }')
    case "$dn_eph" in ''|*[!0-9]*) ERROR="ip_local_port_range unreadable: $dn_eph"; return 1;; esac
    [ "$dn_eph" -gt 1 ] || { ERROR="ip_local_port_range starts at $dn_eph"; return 1; }
    run iptables -t nat -A PREROUTING -i eth0 -d "$dn_ip/32" -p tcp -j DNAT --to-destination 127.0.0.1 || return 1
    run iptables -t nat -A PREROUTING -d "$dn_d0/32" -p tcp --dport "1:$((dn_eph - 1))" -j DNAT --to-destination 127.0.0.1 || return 1
  fi
  NOTICE="own IP $dn_ip, docker0 $dn_d0, backend $dn_gw:7718, limit $LIMIT"
}

# ── Step 3a: the overlays of a copy ─────────────────────────────────────────────────────────────────────────────
# All functions here run behind `if`, so without `set -e`: every command carries its own handling, the error stands in OV_ERROR
# (one line, paths without the test root).
singleLine() { printf '%s' "$1" | tr '\n' ' '; }
display() { printf '%s' "${1#"$W"}"; }
# Several paths (one line per path) as one line, each without the test root.
display_rows() { printf '%s\n' "$1" | while IFS= read -r az; do printf '%s ' "${az#"$W"}"; done; }

# Split a line from ov_row into ov_z, ov_u, ov_o, ov_w — checked. Never a mount: only when ALL lines are good does copy_mount mount
# anything (a broken file mounts nothing).
ov_split() {
  ov_tabs=$(printf '%s' "$ov_row" | tr -cd '\t')
  if [ "${#ov_tabs}" -ne 3 ]; then
    OV_ERROR="overlay: line “$(singleLine "$ov_row")” does not have four fields (target, lower, upper, work)"; return 1
  fi
  ov_z=${ov_row%%"$TAB"*}; ov_r=${ov_row#*"$TAB"}
  ov_u=${ov_r%%"$TAB"*};     ov_r=${ov_r#*"$TAB"}
  ov_o=${ov_r%%"$TAB"*};     ov_w=${ov_r#*"$TAB"}
  for ov_p in "$ov_z" "$ov_u" "$ov_o" "$ov_w"; do
    case "$ov_p" in
      /*) ;;
      *) OV_ERROR="overlay: $ov_z — “$ov_p” is not an absolute path"; return 1;;
    esac
  done
  for ov_p in "$ov_u" "$ov_o" "$ov_w"; do
    case "$ov_p" in
      *,*|*\\*|*\"*) OV_ERROR="overlay: $ov_z — “$ov_p” contains , \\ or \" (cannot be represented as a mount option)"; return 1;;
    esac
  done
  case "$ov_u" in
    *:*) OV_ERROR="overlay: $ov_z — “$ov_u” contains : (lowerdir separates layers there)"; return 1;;
  esac
}

copy_mount() {
  if [ ! -f "$OVERLAYS" ] || [ ! -r "$OVERLAYS" ]; then
    OV_ERROR="overlay: /cbase-copy/overlays.tsv is not a readable file"; return 1
  fi
  ov_list=$(LC_ALL=C sort -- "$OVERLAYS") || { OV_ERROR="overlay: /cbase-copy/overlays.tsv not readable"; return 1; }
  # First pass: check every line, detect duplicate targets (neighbours after sorting).
  ov_rows=0
  ov_prior=""
  while IFS= read -r ov_row; do
    [ -n "$ov_row" ] || continue
    ov_rows=$((ov_rows + 1))
    ov_split || return 1
    if [ "$ov_z" = "$ov_prior" ]; then
      OV_ERROR="overlay: $ov_z — appears twice in overlays.tsv"; return 1
    fi
    ov_prior=$ov_z
  done <<OV_END
$ov_list
OV_END
  [ "$ov_rows" -gt 0 ] || { OV_ERROR="overlay: /cbase-copy/overlays.tsv without a line"; return 1; }
  # Second pass: mount, outer before inner (the sorting).
  while IFS= read -r ov_row; do
    [ -n "$ov_row" ] || continue
    ov_split || return 1
    if "$MOUNTPOINT_BIN" -q "$W$ov_z" 2>/dev/null; then
      ov_actual=$(target_mount "$W$ov_z" "$W$ov_u" "$W$ov_o" 2>&1) \
        || { OV_ERROR="overlay: $ov_z — already a mount point, /proc/self/mountinfo not readable — $(singleLine "$ov_actual")"; return 1; }
      if [ "$ov_actual" = same ]; then
        log "overlay: $ov_z is already mounted (this overlay)"
        continue
      fi
      OV_ERROR="overlay: $ov_z — already a mount point ($(singleLine "$ov_actual")), not the overlay from overlays.tsv"
      return 1
    fi
    ov_out=$(mkdir -p "$W$ov_z" 2>&1) || { OV_ERROR="overlay: $ov_z — mkdir: $(singleLine "$ov_out")"; return 1; }
    ov_out=$(LIBMOUNT_FORCE_MOUNT2=always "$MOUNT_BIN" -t overlay overlay \
      -o "userxattr,lowerdir=$W$ov_u,upperdir=$W$ov_o,workdir=$W$ov_w" "$W$ov_z" 2>&1) \
      || { OV_ERROR="overlay: $ov_z — $(singleLine "$ov_out")"; return 1; }
    log "overlay: $ov_z mounted"
  done <<OV_END
$ov_list
OV_END
}

# Until /cbase-copy/.prepared is there — loop until the event, cap PREPARE_S with a message.
copy_wait() {
  [ ! -e "$PREPARED" ] || return 0
  status prepare "Overlays mounted, waiting for /cbase-copy/.prepared"
  ov_from=$(date +%s) || { OV_ERROR="prepare: date +%s failed"; return 1; }
  while [ ! -e "$PREPARED" ]; do
    ov_now=$(date +%s) || { OV_ERROR="prepare: date +%s failed"; return 1; }
    if [ $((ov_now - ov_from)) -ge "$PREPARE_S" ]; then
      OV_ERROR="prepare: /cbase-copy/.prepared not there after $PREPARE_S s (cap CBASE_PROJECTBOX_PREPARE_S)"
      return 1
    fi
    sleep "$TICK"
  done
}

# The mount points at or below /cbase-copy and /cbase-main, from mountinfo (field 5, with the kernel's escapes \040 \011 \012 \134 for
# space, tab, newline, backslash), one line per path. A path with a newline cannot be represented this way and comes as a line "!" —
# the caller takes it as an error.
MOUNT_POINTS_AWK='
function decode(s,   r, i, c) {
  r = ""
  while ((i = index(s, "\\")) > 0) {
    c = substr(s, i + 1, 3)
    r = r substr(s, 1, i - 1)
    if (c == "040") r = r " "
    else if (c == "011") r = r "\t"
    else if (c == "134") r = r "\\"
    else if (c == "012") { nl = 1; r = r "?" }
    else { r = r "\\"; s = substr(s, i + 1); continue }
    s = substr(s, i + 4)
  }
  return r s
}
function under(m, w) { return m == w || substr(m, 1, length(w) + 1) == w "/" }
BEGIN { k = ENVIRON["AWK_COPY"]; h = ENVIRON["AWK_MAIN"] }
{ nl = 0; m = decode($5); if (under(m, k) || under(m, h)) print (nl ? "!" : m) }
'
mountPoints() { AWK_COPY="$COPY" AWK_MAIN="$MAIN" awk "$MOUNT_POINTS_AWK" "$MOUNTINFO"; }

# What hangs at the target: the LAST line with field 5 == target (it hides the earlier ones). Behind the separator "-" stand type,
# source and the superblock options (escapes as above, plus \054 for a comma in an option value). Output "same" if it is an
# overlay with exactly this lowerdir and upperdir; otherwise "<type> <source>" or "no entry …".
TARGET_AWK='
function decode(s,   r, i, c) {
  r = ""
  while ((i = index(s, "\\")) > 0) {
    c = substr(s, i + 1, 3)
    r = r substr(s, 1, i - 1)
    if (c == "040") r = r " "
    else if (c == "011") r = r "\t"
    else if (c == "012") r = r "\n"
    else if (c == "134") r = r "\\"
    else if (c == "054") r = r ","
    else { r = r "\\"; s = substr(s, i + 1); continue }
    s = substr(s, i + 4)
  }
  return r s
}
BEGIN { z = ENVIRON["AWK_TARGET"]; n = 0 }
decode($5) == z {
  for (i = 7; i <= NF && $i != "-"; i++) ;
  fstype = $(i + 1); src = $(i + 2); opt = $(i + 3); n++
}
END {
  if (!n) { print "no entry in /proc/self/mountinfo"; exit }
  lo = ""; up = ""
  m = split(opt, t, ",")
  for (k = 1; k <= m; k++) {
    if (substr(t[k], 1, 9) == "lowerdir=") lo = decode(substr(t[k], 10))
    else if (substr(t[k], 1, 9) == "upperdir=") up = decode(substr(t[k], 10))
  }
  if (fstype == "overlay" && lo == ENVIRON["AWK_BOTTOM"] && up == ENVIRON["AWK_TOP"]) print "same"
  else print fstype " " decode(src) (fstype == "overlay" ? " with other layers" : "")
}
'
target_mount() { AWK_TARGET="$1" AWK_BOTTOM="$2" AWK_TOP="$3" awk "$TARGET_AWK" "$MOUNTINFO"; }

raw_unmount() {
  ov_mp=$(mountPoints 2>&1) || { OV_ERROR="unmount: /proc/self/mountinfo not readable — $(singleLine "$ov_mp")"; return 1; }
  if printf '%s\n' "$ov_mp" | grep -qx '!'; then
    OV_ERROR="unmount: a mount point below /cbase-copy or /cbase-main contains a newline"; return 1
  fi
  # Sorted descending, every path stands before the path it lies under: inner before outer.
  ov_mp=$(printf '%s\n' "$ov_mp" | LC_ALL=C sort -r -u)
  while IFS= read -r ov_p; do
    [ -n "$ov_p" ] || continue
    ov_out=$("$UMOUNT_BIN" -l "$ov_p" 2>&1) || { OV_ERROR="unmount: $(display "$ov_p") — $(singleLine "$ov_out")"; return 1; }
    log "unmount: $(display "$ov_p")"
  done <<OV_END
$ov_mp
OV_END
  # The second reading: afterwards nothing stands under either root.
  ov_mp=$(mountPoints 2>&1) || { OV_ERROR="unmount: /proc/self/mountinfo not readable — $(singleLine "$ov_mp")"; return 1; }
  [ -z "$ov_mp" ] || { OV_ERROR="unmount: still mounted afterwards: $(display_rows "$ov_mp")"; return 1; }
}

copy_prepare() { copy_mount && copy_wait && raw_unmount; }

# Live without dockerd until TERM/INT comes (passing on ends the sleep and the script). A background `sleep` with `wait`: a signal
# interrupts `wait` at once, a foreground `sleep` would hold the trap up until it ends.
without_dockerd_rest() {
  while :; do
    sleep 3600 &
    QUIET_PID=$!
    wait "$QUIET_PID" || :
  done
}

# ── 1. Pool ──────────────────────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$W/run"
rm -f "$STATUS" "$STATUS.new"
POOL="${CBASE_DOCKER_POOL:-}"
if ! printf '%s\n' "$POOL" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$'; then
  log "CBASE_DOCKER_POOL is missing or not an IPv4 CIDR (“$POOL”) — no dockerd"
  status error "pool: CBASE_DOCKER_POOL is missing or not an IPv4 CIDR"
  exit 64
fi
status start "Pool $POOL"

# ── 2. nest cgroup v2 (like docker:dind) ─────────────────────────────────────────────────────────────────
CG="$W/sys/fs/cgroup"
if [ -f "$CG/cgroup.controllers" ] && ! cgroup_nest; then
  log "cgroup: $CG_ERROR — dockerd starts without delegation, the container stays at phase=error"
  status error "cgroup"
fi

# ── 3. leftovers of a hard end ──────────────────────────────────────────────────────────────────────────────────
rm -f "$W/var/run/docker.pid" "$W/run/docker/containerd/containerd.pid" "$W/var/run/docker.sock"

# ── 3a. overlays of a copy — only with /cbase-copy/overlays.tsv ────────────────────────────────────────
# If it exists (even as a dead link): first all overlays, then .prepared, then the raw roots go — otherwise no dockerd, and the
# script lives until TERM.
if [ -e "$OVERLAYS" ] || [ -L "$OVERLAYS" ]; then
  case "$PREPARE_S" in
    ''|*[!0-9]*) log "CBASE_PROJECTBOX_PREPARE_S “$PREPARE_S” is not a number — 3600"; PREPARE_S=3600;;
  esac
  if ! copy_prepare; then
    log "$OV_ERROR — no dockerd, the container waits for TERM"
    status error "$OV_ERROR"
    without_dockerd_rest
  fi
fi

# ── 4. daemon.json ───────────────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$W/etc/docker"
printf '{\n  "default-address-pools": [\n    { "base": "%s", "size": 24 }\n  ],\n  "log-opts": { "max-size": "100m", "max-file": "5" }\n}\n' \
  "$POOL" > "$W/etc/docker/daemon.json.new"
mv -f "$W/etc/docker/daemon.json.new" "$W/etc/docker/daemon.json"

# ── 5. dockerd ───────────────────────────────────────────────────────────────────────────────────────────────────
status wait "dockerd started, waiting for docker info"
dockerd &
DOCKERD_PID=$!
log "dockerd pid $DOCKERD_PID, Pool $POOL"

# ── 6. wait until docker info answers ─────────────────────────────────────────────────────────────────────────
READY=""
attempt=0
while [ -z "$END" ]; do
  kill -0 "$DOCKERD_PID" 2>/dev/null || break
  if docker info >/dev/null 2>&1; then READY=1; break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    log "docker info does not answer after $attempt attempts (cap) — going on without DNAT"
    status error "info: docker info does not answer after $attempt attempts (cap) — without DNAT"
    break
  fi
  sleep "$TICK"
done

# ── 7./8. DNAT, never fatal ──────────────────────────────────────────────────────────────────────────────────────
if [ -n "$READY" ] && [ -z "$END" ]; then
  if dnat; then
    status ready "$NOTICE"
    log "ready: $NOTICE"
  else
    log "DNAT failed: $ERROR — the container keeps running without it"
    status error "dnat: $ERROR"
  fi
elif [ -z "$READY" ] && [ -z "$END" ] && ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
  status error "dockerd: ended before docker info answered"
fi

# ── 9. wait for dockerd, pass its code on ──────────────────────────────────────────────────────────────
# A signal interrupts `wait` (code > 128, then the trap runs): keep waiting as long as dockerd lives. If it ended exactly between
# the interruption and `kill -0`, its status still lies with the shell — the last `wait` fetches it (127 means: already fetched,
# then the previous code counts).
rc=0
while :; do
  rc=0
  wait "$DOCKERD_PID" || rc=$?
  kill -0 "$DOCKERD_PID" 2>/dev/null || break
done
if [ "$rc" -gt 128 ]; then
  rc2=0
  wait "$DOCKERD_PID" 2>/dev/null || rc2=$?
  [ "$rc2" -eq 127 ] || rc=$rc2
fi
log "dockerd ended with $rc"
status ended "dockerd ended with $rc"
exit "$rc"
