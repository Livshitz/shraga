#!/usr/bin/env bash
# Upgrade supervisor — runs DETACHED, outside the server it is upgrading.
#
# WHY A SCRIPT AND NOT SERVER CODE: an upgrade restarts the server, so the process that starts the
# upgrade cannot observe whether it worked. Anything that must survive the restart — the verify, and
# above all the REVERT — has to live outside it. This is the same shape as power-guard.sh and
# health-watchdog.sh, and it is the whole reason a self-upgrade can be trusted: the rollback path
# does not depend on the code being rolled back.
#
# Contract (all via env, no positional args):
#   APP_ROOT      consumer root holding package.json + the lockfile        (required)
#   PKG           dependency name to re-pin, normally "shraga"             (required)
#   TARGET        version to install, e.g. 0.1.35                          (required)
#   FROM          version currently pinned, restored on failure            (required)
#   RESTART_CMD   how to restart the service                               (required)
#   HEALTH_URL    must report TARGET after the restart                     (required)
#   REPORT        JSON report path; the server reads it on next boot       (required)
#   BUN           bun binary                                  (default: bun on PATH)
#   BOOT_TIMEOUT  seconds to wait for the version to flip     (default: 180)
#   SOAK          seconds it must KEEP answering after that   (default: 60)
#
# Exit code is advisory only — nobody is listening. The REPORT file is the real output.
set -uo pipefail

: "${APP_ROOT:?}" "${PKG:?}" "${TARGET:?}" "${FROM:?}" "${RESTART_CMD:?}" "${HEALTH_URL:?}" "${REPORT:?}"
BUN="${BUN:-bun}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}"
SOAK="${SOAK:-60}"

# ── Escape the service cgroup ─────────────────────────────────────────────────
# Under systemd the default KillMode=control-group kills EVERY process in the unit's cgroup on
# restart — and a detached child of the server is in that cgroup. So the supervisor would be killed
# by the very restart it triggers, taking the verify AND the rollback with it: exactly the guarantees
# it exists to provide. Re-exec into a transient scope (same uid, so `bun install` doesn't leave
# root-owned files) and we live outside the unit. Best-effort: where systemd-run or passwordless sudo
# is absent, carry on in-cgroup — an unsupervised upgrade still beats no upgrade.
if [ -z "${UPGRADE_DETACHED:-}" ]; then
  export UPGRADE_DETACHED=1
  if command -v systemd-run >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    escape=(sudo -n systemd-run --scope --quiet --collect --uid="$(id -u)" --gid="$(id -g)")
    for v in APP_ROOT PKG TARGET FROM RESTART_CMD HEALTH_URL REPORT BUN BOOT_TIMEOUT SOAK PATH UPGRADE_DETACHED; do
      escape+=("--setenv=$v=${!v-}")
    done
    exec "${escape[@]}" bash "$0"
  fi
fi

cd "$APP_ROOT" || exit 1
BACKUP="$(mktemp -d)"
LOG="${REPORT%.json}.log"
exec >>"$LOG" 2>&1

# python3 edits package.json and escapes the report. Check it BEFORE anything is touched: discovering
# it missing halfway through means a rewritten pin we can no longer safely put back. SelfUpgrade
# .blockers() checks this too, so a deployment normally learns about it at request time, not here.
if ! command -v python3 >/dev/null 2>&1; then
  printf '{"status":"failed","detail":"python3 not found on PATH — nothing was changed","from":"%s","target":"%s","installed":"%s","package":"%s","log":"%s","finishedAt":"%s"}\n' \
    "$FROM" "$TARGET" "$FROM" "$PKG" "$LOG" "$(date -u '+%FT%TZ')" > "$REPORT"
  exit 1
fi

ts() { date '+%F %T'; }
say() { echo "[upgrade] $(ts) $*"; }

# The report is the only channel back to the server, so write it defensively: a partial or
# unparseable file must not look like a success.
write_report() { # status detail installed
  local tmp="$REPORT.tmp"
  cat > "$tmp" <<JSON
{
  "status": "$1",
  "detail": $(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "from": "$FROM",
  "target": "$TARGET",
  "installed": "$3",
  "package": "$PKG",
  "log": "$LOG",
  "finishedAt": "$(date -u '+%FT%TZ')"
}
JSON
  mv "$tmp" "$REPORT"
}

# Snapshot EVERYTHING the install can rewrite. Restoring package.json without its lockfile would
# resolve a different tree than the one that was known-good.
snapshot() {
  cp package.json "$BACKUP/" 2>/dev/null || return 1
  for f in bun.lock bun.lockb package-lock.json; do [ -f "$f" ] && cp "$f" "$BACKUP/"; done
  return 0
}
restore() {
  cp "$BACKUP/package.json" package.json || return 1
  for f in bun.lock bun.lockb package-lock.json; do [ -f "$BACKUP/$f" ] && cp "$BACKUP/$f" "$f"; done
  return 0
}

# Rewrite ONLY this dep's pin, leaving the rest of package.json byte-identical (a JSON round-trip
# would reformat a file the deployment owns). Text editing a structured file is only safe if it is
# unambiguous, so this refuses unless exactly ONE "<pkg>": "<version>" pair exists AND its current
# value is the one we expect — a package.json that also names the package under overrides/
# resolutions/peerDependencies must not be edited by guesswork.
pin() { # new-version expected-current-version
  PKG="$PKG" NEW="$1" EXPECT="$2" python3 - <<'PY'
import os, re, sys
pkg, new, expect = os.environ['PKG'], os.environ['NEW'], os.environ['EXPECT']
src = open('package.json').read()
pat = re.compile(r'("%s"\s*:\s*")([^"]*)(")' % re.escape(pkg))
hits = list(pat.finditer(src))
if len(hits) != 1:
    sys.exit(f'expected exactly one "{pkg}" version entry in package.json, found {len(hits)}')
current = hits[0].group(2).lstrip('^~')
if expect and current != expect:
    sys.exit(f'package.json has {pkg}@{hits[0].group(2)}, expected {expect} — refusing to edit')
m = hits[0]
open('package.json', 'w').write(src[:m.start()] + m.group(1) + new + m.group(3) + src[m.end():])
PY
}

# Healthy = the endpoint answers AND reports the version we expect. "It responds" is not enough:
# a server that came back on the OLD version is a failed upgrade, not a healthy one.
reports_version() { # version
  local body
  body="$(curl -sf -m 10 "$HEALTH_URL" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -q "\"$1\"" || return 1
  return 0
}

wait_for_version() { # version timeout
  local deadline=$(( SECONDS + $2 ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    reports_version "$1" && return 0
    sleep 5
  done
  return 1
}

# A server that boots, flips the version, then dies 20s later has NOT upgraded successfully — that is
# exactly the crash-loop an unattended upgrade must catch. Keep probing for the whole soak window.
# One dropped probe is not a crash-loop. This runs on a busy box where a single request can lose a
# 10s race (MCP mounts, a GC pause, the drain window of the restart we just did), and a zero-
# tolerance soak turns that blip into an automatic rollback of a perfectly good version — observed
# reverting 0.1.48 on feedox while the process stayed up throughout. Require CONSECUTIVE misses, so
# a real crash (which never answers again) still fails fast.
SOAK_MISS_LIMIT="${SOAK_MISS_LIMIT:-3}"
soak() { # version seconds
  local deadline=$(( SECONDS + $2 )) misses=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if reports_version "$1"; then
      misses=0
    else
      misses=$(( misses + 1 ))
      say "soak probe missed ($misses/$SOAK_MISS_LIMIT)"
      [ "$misses" -ge "$SOAK_MISS_LIMIT" ] && return 1
    fi
    sleep 5
  done
  return 0
}

install_and_restart() { # version expected-current label
  say "installing $PKG@$1 ($3)"
  if ! pin "$1" "$2"; then say "pin failed"; return 1; fi
  if ! "$BUN" install; then say "bun install failed"; return 1; fi
  say "restarting via: $RESTART_CMD"
  eval "$RESTART_CMD" || say "restart command returned non-zero (continuing — some managers do)"
  return 0
}

# ── Upgrade ───────────────────────────────────────────────────────────────────
say "=== $PKG $FROM -> $TARGET ==="
if ! snapshot; then
  write_report failed "could not snapshot package.json in $APP_ROOT — refused to touch anything" "$FROM"
  exit 1
fi

if ! install_and_restart "$TARGET" "$FROM" upgrade; then
  restore && "$BUN" install >/dev/null 2>&1
  write_report failed "install of $PKG@$TARGET failed; package.json restored, service untouched" "$FROM"
  exit 1
fi

if wait_for_version "$TARGET" "$BOOT_TIMEOUT" && soak "$TARGET" "$SOAK"; then
  say "verified $TARGET (booted + soaked ${SOAK}s)"
  write_report ok "upgraded to $TARGET and verified for ${SOAK}s" "$TARGET"
  exit 0
fi

# ── Revert ────────────────────────────────────────────────────────────────────
say "verification FAILED — reverting to $FROM"
if ! restore; then
  write_report revert-failed "upgrade to $TARGET failed AND the backup could not be restored — MANUAL FIX NEEDED. Backup: $BACKUP" unknown
  exit 1
fi
if ! install_and_restart "$FROM" "" revert; then
  write_report revert-failed "upgrade to $TARGET failed and reinstalling $FROM ALSO failed — MANUAL FIX NEEDED. Backup: $BACKUP" unknown
  exit 1
fi

if wait_for_version "$FROM" "$BOOT_TIMEOUT"; then
  say "reverted to $FROM"
  write_report reverted "upgrade to $TARGET failed verification; reverted to $FROM and confirmed healthy" "$FROM"
  rm -rf "$BACKUP"
  exit 0
fi

write_report revert-failed "upgrade to $TARGET failed and the revert to $FROM did not come back healthy — MANUAL FIX NEEDED. Backup: $BACKUP" unknown
exit 1
