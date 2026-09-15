#!/usr/bin/env bash
# harden-audit.sh — make shraga's audit log append-only at the OS level. Linux + root. Idempotent: run it from cron.
#
#   sudo harden-audit.sh <DATA_DIR>                 (or DATA_DIR=<dir> sudo -E harden-audit.sh)
#   root crontab, hourly:  17 * * * *  /app/node_modules/shraga/src/scripts/harden-audit.sh /app/data-prod
#
# `chattr +a` on <DATA_DIR>/audit/: the server user can still create month files and append, but can't delete or
# rename any entry. `chattr +a` on each YYYY-MM.jsonl: it opens for append only — no truncate, no rewrite.
# New files do NOT inherit +a (it is not in ext4's EXT4_FL_INHERITED nor XFS's inherited flags), so a new month's
# file stays truncatable until the next run — hence hourly cron. Retention/rotation is a root-only op (chattr -a).
# +a can't stop the server user from CREATING a month entry as a symlink/directory (planted). Those are never hardened:
# they're reported and the script exits non-zero — after +a is applied to every valid file. The server refuses to
# append through them and alerts owners. Remove one as root: chattr -a "$audit"; rm -r <entry>; re-run.
set -euo pipefail

[ "$(uname -s)" = Linux ] || { echo "harden-audit: Linux only (chattr) — nothing done" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "harden-audit: must run as root (chattr +a needs CAP_LINUX_IMMUTABLE)" >&2; exit 1; }
data="${1:-${DATA_DIR:-}}"
[ -n "$data" ] || { echo "usage: $0 <DATA_DIR>" >&2; exit 2; }
audit="$(realpath "$data")/audit"
[ -d "$audit" ] && [ ! -L "$audit" ] || { echo "harden-audit: $audit is not a directory (start the server once first)" >&2; exit 1; }
# Builds before tamper protection lock INSIDE the audit dir; in an append-only dir that lock can never be released.
if [ -e "$audit/.lock" ]; then
  {
    echo "harden-audit: $audit/.lock exists — left by a pre-tamper-protection shraga (it locks inside the audit dir)."
    echo "  1. Verify no old build is running against $data (e.g. ps -eo pid,args | grep shraga); upgrade or stop it."
    if lsattr -d "$audit" 2>/dev/null | awk '{print $1}' | grep -q a; then
      echo "  2. $audit is already append-only, so first: chattr -a '$audit'"
      echo "  3. As root: rmdir '$audit/.lock'"
    else
      echo "  2. As root: rmdir '$audit/.lock'"
    fi
    echo "  Then re-run: $0 $data"
  } >&2
  exit 1
fi

chattr +a "$audit"
shopt -s nullglob
files=() bad=()
for f in "$audit"/*.jsonl; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then files+=("$f"); else bad+=("$f"); fi
done
for f in "${files[@]}"; do chattr +a "$f"; done

lsattr -d "$audit"
[ ${#files[@]} -eq 0 ] || lsattr "${files[@]}"
echo "harden-audit: $audit append-only (+${#files[@]} month files) — server can append, not truncate/delete/rename"

if [ ${#bad[@]} -gt 0 ]; then
  for f in "${bad[@]}"; do
    echo "harden-audit: ERROR — $f is not a regular file ($(stat -c %F "$f" 2>/dev/null || echo unknown)$([ -L "$f" ] && echo " -> $(readlink "$f")")); possibly PLANTED to divert or disable auditing. NOT hardened. Inspect, then as root: chattr -a '$audit' && rm -r '$f' && $0 $data" >&2
  done
  exit 1
fi
