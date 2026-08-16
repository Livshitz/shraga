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

cd "$APP_ROOT" || exit 1
BACKUP="$(mktemp -d)"
LOG="${REPORT%.json}.log"
exec >>"$LOG" 2>&1

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

pin() { # version — rewrite only this dep's pin, leaving the rest of package.json byte-identical
  PKG="$PKG" V="$1" python3 - <<'PY'
import json, os, re
pkg, ver = os.environ['PKG'], os.environ['V']
src = open('package.json').read()
pat = re.compile(r'("%s"\s*:\s*")[^"]*(")' % re.escape(pkg))
if not pat.search(src):
    raise SystemExit(f'{pkg} not found in package.json')
open('package.json', 'w').write(pat.sub(lambda m: m.group(1) + ver + m.group(2), src, count=1))
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
soak() { # version seconds
  local deadline=$(( SECONDS + $2 ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    reports_version "$1" || return 1
    sleep 5
  done
  return 0
}

install_and_restart() { # version label
  say "installing $PKG@$1 ($2)"
  if ! pin "$1"; then say "pin failed"; return 1; fi
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

if ! install_and_restart "$TARGET" upgrade; then
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
if ! install_and_restart "$FROM" revert; then
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
