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
set -euo pipefail

[ "$(uname -s)" = Linux ] || { echo "harden-audit: Linux only (chattr) — nothing done" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "harden-audit: must run as root (chattr +a needs CAP_LINUX_IMMUTABLE)" >&2; exit 1; }
data="${1:-${DATA_DIR:-}}"
[ -n "$data" ] || { echo "usage: $0 <DATA_DIR>" >&2; exit 2; }
audit="$(realpath "$data")/audit"
[ -d "$audit" ] || { echo "harden-audit: $audit does not exist (start the server once first)" >&2; exit 1; }
# Builds before tamper protection lock INSIDE the audit dir; in an append-only dir that lock can never be released.
[ ! -e "$audit/.lock" ] || { echo "harden-audit: $audit/.lock exists — a pre-tamper-protection shraga still locks inside the dir; upgrade first" >&2; exit 1; }

chattr +a "$audit"
shopt -s nullglob
files=("$audit"/*.jsonl)
for f in "${files[@]}"; do chattr +a "$f"; done

lsattr -d "$audit"
[ ${#files[@]} -eq 0 ] || lsattr "${files[@]}"
echo "harden-audit: $audit append-only (+${#files[@]} month files) — server can append, not truncate/delete/rename"
