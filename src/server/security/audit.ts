// Audit: append-only, hash-chained JSONL log at data/audit/YYYY-MM.jsonl (UTC month).
//
// Each line = {ts, type, principal?, role?, sessionId?, target?, reason?, meta?, prevHash, hash} where
// hash = sha256(prevHash + canonical(line without hash)) and canonical = JSON with keys sorted recursively.
// The chain is ONE chain across months and restarts: on construct the last hash is recovered by reading the
// newest file backwards from its end (never the whole file). The first-ever line carries GENESIS_HASH.
// Head state is shared per resolved dir within the process, so several Audit instances on one dir append to one chain.
// Across PROCESSES (blue-green flip: promoted instance + the old one's drain lines) every append holds a cross-process
// mutex — mkdir(<dir>/.lock), atomic on a local fs — across the whole re-sync + write: if the NEWEST month file in the dir
// isn't the file/size we last left (another process appended or rotated), tail recovery re-runs before linking. So
// writers that take the lock serialize into one chain. The wait is bounded (LOCK_WAIT_MS): on timeout the append fails
// (counted, logged, not written). A lock older than LOCK_STALE_MS (holder died mid-section) is broken with a warn.
// Residual gaps: a writer that doesn't take the lock (a pre-lock build during its own flip) is only size-detected and
// can still fork; two processes breaking the same stale lock at once can both enter. verify() reports any fork.
//
// Crash safety: a partial last line (crash mid-write, failed append) is sealed with '\n' on recovery and after a
// failed append, so the next record starts on its own line and links to the last GOOD hash. verify() still reports
// the partial line as `unparseable` (the break is real); records after it chain correctly from the good hash.
//
// append() never throws into the caller: a failed write is logged, counted in `failures`, and does not
// advance the chain. If the dir exists but can't be read during recovery, the instance is unhealthy and appends
// fail (rather than restart from genesis and fork) until a recovery succeeds.
//
// Limitations — the chain is UNKEYED: anyone with write access can rewrite the whole log with recomputed hashes, and
// deleting the newest file(s) or tail lines leaves a valid shorter chain. Neither is detectable without an external
// head anchor; the OS append-only flag (`chattr +a`) + offsite copy (tamper-protection step) are the mitigation.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';

export type AuditEventType =
  | 'auth.allow' | 'auth.deny' | 'role.resolve' | 'turn.start' | 'turn.end' | 'tool.allow' | 'tool.deny'
  | 'guard.limit' | 'guard.block' | 'escalate' | 'policy.change' | 'policy.tamper'
  | 'key.create' | 'key.revoke' | 'token.revoke' | 'session.delete';

const TYPES = new Set<string>(['auth.allow', 'auth.deny', 'role.resolve', 'turn.start', 'turn.end', 'tool.allow', 'tool.deny',
  'guard.limit', 'guard.block', 'escalate', 'policy.change', 'policy.tamper', 'key.create', 'key.revoke', 'token.revoke', 'session.delete']);

/**
 * What callers pass. `meta` must carry ids/names/enums — NOT free text (conversations already hold content).
 * Sanitization is a safety net, not DLP:
 * - EVERY string (top-level fields, meta keys and values, array items) is truncated to `maxString` FIRST (bounds regex
 *   cost), then only the credential substring (Bearer/Basic + ≥16-char token, sk-…, xox?-…, JWT, PEM key) → '[redacted]'.
 * - meta keys named (whole, or as a `_`/`-`/camelCase suffix) token, accessToken, refreshToken, secret, clientSecret,
 *   password, passwd, pwd, authorization, cookie, apiKey, privateKey, signature are STRIPPED at any depth; `*Id` keys stay.
 *   Keys named exactly prompt, body, content, text, message(s), input, output are stripped too.
 * - meta depth ≤ 4, arrays ≤ 50 items; serialized meta over `maxMetaBytes` is replaced by `{ _truncated: true, keys }`.
 */
export interface AuditEvent {
  type: AuditEventType;
  principal?: string;
  role?: string;
  sessionId?: string;
  target?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}
export interface AuditRecord extends AuditEvent { ts: string; prevHash: string; hash: string }
export interface AuditQuery { from?: string | number | Date; to?: string | number | Date; type?: AuditEventType | AuditEventType[]; principal?: string; limit: number; cursor?: string }
export interface AuditPage { items: AuditRecord[]; nextCursor?: string }
export interface AuditVerify { ok: boolean; lines: number; brokenAt?: { file: string; line: number; reason: 'unparseable' | 'prev-hash' | 'hash' | 'unreadable' } }

export const GENESIS_HASH = '0'.repeat(64);
const FILE_RE = /^\d{4}-\d{2}\.jsonl$/;
const SECRET_NAMES = new Set(['token', 'accesstoken', 'refreshtoken', 'secret', 'clientsecret', 'password', 'passwd', 'pwd', 'authorization', 'cookie', 'apikey', 'privatekey', 'signature']);
const CONTENT_KEY_RE = /^(prompt|body|content|text|messages?|input|output)$/i;
const CRED_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}|\bsk-[A-Za-z0-9_-]{10,}|\bxox[a-z]-[A-Za-z0-9-]*|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|-----BEGIN [A-Z ]*KEY-----[\s\S]*?(?:-----END [A-Z ]*KEY-----|$)/gi;
/** Whole key, or its last one/two `_`/`-`/camelCase words, is a secret name. `*Id` keys (apiKeyId) are ids, kept. */
const isSecretKey = (k: string) => {
  if (k.endsWith('Id')) return false;
  const w = k.split(/[_-]|(?<=[a-z0-9])(?=[A-Z])/).map(s => s.toLowerCase());
  return [w.join(''), w.at(-1)!, w.slice(-2).join('')].some(n => SECRET_NAMES.has(n));
};
const CHUNK = 64 * 1024;
const MAX_QUERY = 1000;
const LOCK_WAIT_MS = 200;
const LOCK_STALE_MS = 2000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep without spinning the CPU (append is sync by contract). */
const sleepSync = (ms: number) => { Atomics.wait(SLEEP, 0, 0, ms); };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted recursively (undefined dropped; array holes/undefined → null, as JSON.stringify writes). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${Array.from(v, x => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => (v as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const hashOf = (rec: Omit<AuditRecord, 'hash'>) => sha256(rec.prevHash + canonical(rec));

/** Lines of `file` from the end backwards, starting before byte `end`. `start` = byte offset of the line. */
function* reverseLines(file: string, end?: number): Generator<{ line: string; start: number }> {
  const fd = openSync(file, 'r');
  try {
    let pos = Math.min(end ?? Infinity, fstatSync(fd).size);
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(CHUNK, pos); pos -= n;
      const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, pos);
      const data = Buffer.concat([buf, tail]);
      let stop = data.length;
      for (let i = data.lastIndexOf(10, stop - 1); i !== -1; i = stop > 0 ? data.lastIndexOf(10, stop - 1) : -1) {
        if (stop > i + 1) yield { line: data.subarray(i + 1, stop).toString('utf8'), start: pos + i + 1 };
        stop = i;
      }
      tail = data.subarray(0, stop);
    }
    if (tail.length) yield { line: tail.toString('utf8'), start: 0 };
  } finally { closeSync(fd); }
}

/** Lines of `file` in order, read in chunks (1-based line numbers, empty lines skipped but counted). */
function* forwardLines(file: string): Generator<{ line: string; n: number }> {
  const fd = openSync(file, 'r');
  try {
    let pos = 0, n = 0, rest = Buffer.alloc(0);
    for (;;) {
      const buf = Buffer.alloc(CHUNK); const got = readSync(fd, buf, 0, CHUNK, pos); pos += got;
      const data = Buffer.concat([rest, buf.subarray(0, got)]);
      let from = 0;
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, from)) {
        n++; if (i > from) yield { line: data.subarray(from, i).toString('utf8'), n };
        from = i + 1;
      }
      rest = data.subarray(from);
      if (!got) break;
    }
    if (rest.length) yield { line: rest.toString('utf8'), n: n + 1 };
  } finally { closeSync(fd); }
}

/** If `file` is non-empty and doesn't end with '\n', append one — a partial line must not absorb the next record. */
function sealTail(file: string): boolean {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
  let partial = false;
  try {
    const size = fstatSync(fd).size;
    if (size) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); partial = b[0] !== 10; }
  } finally { closeSync(fd); }
  if (partial) appendFileSync(file, '\n');
  return partial;
}

const parse = (line: string): AuditRecord | null => {
  try { const r = JSON.parse(line); return r && typeof r.hash === 'string' && typeof r.prevHash === 'string' ? r : null; } catch { return null; }
};
const toIso = (v: string | number | Date) => new Date(v).toISOString();
/** Canonical dir identity: realpath of the nearest existing ancestor + the rest (a symlink spelling or a not-yet-created dir under /var → /private/var must not get its own head). */
const realDir = (dir: string): string => {
  const abs = path.resolve(dir);
  try { return realpathSync(abs); } catch { const up = path.dirname(abs); return up === abs ? abs : path.join(realDir(up), path.basename(abs)); }
};

/** Chain head per real dir, shared by every Audit instance in the process. */
interface Head {
  lastHash: string; lastMonth: string; healthy: boolean;
  /** The file and its size right after our last append/recovery. Anything else on disk = another process wrote. */
  lastWrite: { file: string; size: number } | null;
}
/** Size of `file` (0 if missing or no file). */
const sizeOf = (file: string): number => {
  if (!file) return 0;
  try { return statSync(file).size; } catch (e: any) { if (e.code === 'ENOENT') return 0; throw e; }
};
const heads = new Map<string, Head>();
/** Test-only: forget shared heads, so the next Audit on a dir gets its own state (simulates another process). */
export function __resetAuditHeadsForTest(): void { heads.clear(); }

export class AuditOptions {
  /** Directory holding YYYY-MM.jsonl files. */
  dir: string = dataPath('audit');
  /** ms epoch; injectable for rotation tests. */
  clock: () => number = Date.now;
  maxString: number = 256;
  maxMetaBytes: number = 2048;
  log: Pick<Console, 'info' | 'warn' | 'error'> = console;
}

export class Audit {
  public options: AuditOptions;
  private state: Head;
  private _failures = 0;

  public constructor(options?: Partial<AuditOptions>) {
    this.options = { ...new AuditOptions(), ...options };
    const key = realDir(this.options.dir);
    this.state = heads.get(key) ?? { lastHash: GENESIS_HASH, lastMonth: '', healthy: true, lastWrite: null };
    heads.set(key, this.state);
    this.recover();
  }

  /** Failed appends since construct — for health. */
  public get failures(): number { return this._failures; }
  public get head(): string { return this.state.lastHash; }
  /** False while the dir exists but can't be read (appends fail instead of forking from genesis). */
  public get healthy(): boolean { return this.state.healthy; }

  /** Month files, sorted. A missing dir is empty; any other read error is logged and thrown. */
  private files(): string[] {
    try { return readdirSync(this.options.dir).filter(f => FILE_RE.test(f)).sort(); } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
      this.options.log.error(`[audit] cannot read ${this.options.dir}: ${e.message}`);
      throw e;
    }
  }

  /** Tail of the newest non-empty file → last good hash. Reads backwards from the end only. */
  private recover(): void {
    const s = this.state;
    try {
      const files = this.files();
      let hash = GENESIS_HASH;
      const newest = files.length ? path.join(this.options.dir, files[files.length - 1]) : '';
      if (newest && sealTail(newest)) this.options.log.warn(`[audit] sealed partial last line in ${files[files.length - 1]}`);
      // Size first, tail read bounded by it: a line another process appends meanwhile shows up as a size mismatch
      // on our next append (→ recover again) instead of being absorbed unseen.
      const size = sizeOf(newest);
      found: for (const f of [...files].reverse()) {
        const fp = path.join(this.options.dir, f);
        for (const { line } of reverseLines(fp, fp === newest ? size : undefined)) {
          const r = parse(line);
          if (r) { hash = r.hash; break found; }
          this.options.log.warn(`[audit] skipping unparseable tail line in ${f}`);
        }
      }
      s.lastHash = hash; s.lastMonth = files.length ? files[files.length - 1].slice(0, 7) : ''; s.healthy = true;
      s.lastWrite = { file: newest, size };
    } catch (e: any) {
      s.healthy = false;
      this.options.log.error(`[audit] chain recovery failed (${this.options.dir}), appends disabled until it succeeds: ${e.message}`);
    }
  }

  /** Truncate (before any regex — bounds its cost), then redact credential substrings. */
  private str(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v), max = this.options.maxString;
    return (s.length > max ? `${s.slice(0, max)}…` : s).replace(CRED_RE, '[redacted]');
  }

  private clean(v: unknown, depth: number): unknown {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return this.str(v);
    if (depth >= 4) return '[depth]';
    if (Array.isArray(v)) return v.slice(0, 50).map(x => this.clean(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [raw, x] of Object.entries(v)) {
        const k = this.str(raw)!; // keys can carry secrets too; the `_truncated.keys` list reuses these
        if (x !== undefined && !isSecretKey(k) && !CONTENT_KEY_RE.test(k)) out[k] = this.clean(x, depth + 1);
      }
      return out;
    }
    return undefined; // functions, symbols, bigint
  }

  /** Enforce the AuditEvent contract (see type doc). */
  public sanitize(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!meta || typeof meta !== 'object') return undefined;
    const m = this.clean(meta, 0) as Record<string, unknown>;
    if (Buffer.byteLength(canonical(m)) <= this.options.maxMetaBytes) return m;
    return { _truncated: true, keys: Object.keys(m).slice(0, 20).map(k => k.slice(0, 64)) };
  }

  /** Take <dir>/.lock (mkdir = atomic). Bounded wait with backoff; breaks a stale lock. False on timeout. */
  private lock(lk: string): boolean {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 0.05; ; wait = Math.min(wait * 2, 5)) {
      try { mkdirSync(lk); return true; } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
      try {
        const age = Date.now() - statSync(lk).mtimeMs;
        if (age > LOCK_STALE_MS) {
          rmdirSync(lk);
          this.options.log.warn(`[audit] broke stale lock ${lk} (${Math.round(age)}ms old)`);
          continue;
        }
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; } // released meanwhile → retry after a short sleep
      if (Date.now() >= deadline) return false;
      sleepSync(wait);
    }
  }

  /** Append one event. Never throws; returns the written record, or null on failure. */
  public append(event: AuditEvent): AuditRecord | null {
    let file: string | undefined, lk: string | undefined;
    const s = this.state;
    try {
      if (!TYPES.has(event?.type)) throw new Error(`unknown audit type "${event?.type}"`);
      mkdirSync(this.options.dir, { recursive: true });
      const lockPath = path.join(this.options.dir, '.lock');
      if (!this.lock(lockPath)) throw new Error(`lock ${lockPath} not acquired within ${LOCK_WAIT_MS}ms`);
      lk = lockPath;
      if (!s.healthy) this.recover();
      if (!s.healthy) throw new Error('audit dir unreadable; chain head unknown');
      // Self-sync under the lock: the NEWEST month file isn't the file/size we last left → another process appended
      // or rotated (possibly into a later month than our clock). Re-read the tail before linking.
      const newestName = this.files().at(-1);
      const newest = newestName ? path.join(this.options.dir, newestName) : '';
      if (!s.lastWrite || s.lastWrite.file !== newest || s.lastWrite.size !== sizeOf(newest)) {
        this.recover();
        if (!s.healthy) throw new Error('audit dir unreadable; chain head unknown');
      }
      const now = new Date(this.options.clock());
      const month = [now.toISOString().slice(0, 7), s.lastMonth].sort()[1];
      file = path.join(this.options.dir, `${month}.jsonl`);
      const size = sizeOf(file);
      const base = { ts: now.toISOString(), type: event.type } as Omit<AuditRecord, 'hash'>; // prevHash set last, for line readability
      const opt = { principal: this.str(event.principal), role: this.str(event.role), sessionId: this.str(event.sessionId), target: this.str(event.target), reason: this.str(event.reason), meta: this.sanitize(event.meta) };
      for (const [k, v] of Object.entries(opt)) if (v !== undefined) (base as any)[k] = v;
      base.prevHash = s.lastHash;
      const rec: AuditRecord = { ...base, hash: hashOf(base) };
      const line = `${JSON.stringify(rec)}\n`;
      appendFileSync(file, line, { mode: 0o600 });
      s.lastHash = rec.hash; s.lastMonth = month;
      s.lastWrite = { file, size: size + Buffer.byteLength(line) }; // expected, not re-stat'd: a racing writer must still mismatch
      return rec;
    } catch (e: any) {
      this._failures++;
      this.options.log.error(`[audit] append failed (${event?.type}): ${e.message}`);
      if (file) try { sealTail(file); } catch (e2: any) { this.options.log.error(`[audit] could not seal ${file}: ${e2.message}`); }
      return null;
    } finally {
      if (lk) try { rmdirSync(lk); } catch (e: any) { this.options.log.error(`[audit] could not release ${lk}: ${e.message}`); }
    }
  }

  /**
   * Newest first, streaming backwards over ALL month files (no month-name pruning: a skewed clock can put any ts in any
   * file); each record is filtered by its own ts. Cursor is opaque (file + byte offset).
   * Throws (after logging) if the dir or a month file can't be read — never a silently short page.
   */
  public query(q: AuditQuery): AuditPage {
    const limit = Math.max(1, Math.min(MAX_QUERY, Math.floor(q.limit) || 1));
    const from = q.from !== undefined ? toIso(q.from) : undefined, to = q.to !== undefined ? toIso(q.to) : undefined;
    const types = q.type === undefined ? undefined : new Set<string>([q.type].flat());
    let cur: { file: string; offset: number } | undefined;
    if (q.cursor) {
      const [file, off] = Buffer.from(q.cursor, 'base64url').toString('utf8').split(':');
      if (!FILE_RE.test(file ?? '') || !/^\d+$/.test(off ?? '')) throw new Error('invalid audit cursor');
      cur = { file, offset: Number(off) };
    }
    const items: AuditRecord[] = [];
    let last: { file: string; start: number } | undefined;
    for (const f of this.files().reverse()) {
      if (cur && f > cur.file) continue;
      try {
        for (const { line, start } of reverseLines(path.join(this.options.dir, f), cur?.file === f ? cur.offset : undefined)) {
          const r = parse(line);
          if (!r || (from && r.ts < from) || (to && r.ts > to) || (types && !types.has(r.type)) || (q.principal !== undefined && r.principal !== q.principal)) continue;
          if (items.length === limit) return { items, nextCursor: Buffer.from(`${last!.file}:${last!.start}`).toString('base64url') };
          items.push(r); last = { file: f, start };
        }
      } catch (e: any) {
        this.options.log.error(`[audit] query cannot read ${f}: ${e.message}`);
        throw e;
      }
    }
    return { items };
  }

  /** Recompute the chain. No file = all files as one chain; a file = that file, seeded from the previous file's tail. */
  public verify(file?: string): AuditVerify {
    let all: string[];
    try { all = this.files(); } catch { return { ok: false, lines: 0, brokenAt: { file: '', line: 0, reason: 'unreadable' } }; }
    let targets = all, expected = GENESIS_HASH, lines = 0, f = '';
    try {
      if (file) {
        const base = path.basename(file), i = all.indexOf(base);
        if (i === -1) return { ok: false, lines: 0, brokenAt: { file: base, line: 0, reason: 'unparseable' } };
        targets = [base];
        for (let j = i - 1; j >= 0 && expected === GENESIS_HASH; j--) {
          f = all[j];
          for (const { line } of reverseLines(path.join(this.options.dir, f))) { const r = parse(line); if (r) { expected = r.hash; break; } }
        }
      }
      for (f of targets) {
        for (const { line, n } of forwardLines(path.join(this.options.dir, f))) {
          lines++;
          const r = parse(line);
          if (!r) return { ok: false, lines, brokenAt: { file: f, line: n, reason: 'unparseable' } };
          if (r.prevHash !== expected) return { ok: false, lines, brokenAt: { file: f, line: n, reason: 'prev-hash' } };
          const { hash, ...rest } = r;
          if (hashOf(rest) !== hash) return { ok: false, lines, brokenAt: { file: f, line: n, reason: 'hash' } };
          expected = hash;
        }
      }
      return { ok: true, lines };
    } catch (e: any) {
      this.options.log.error(`[audit] verify cannot read ${f}: ${e.message}`);
      return { ok: false, lines, brokenAt: { file: f, line: 0, reason: 'unreadable' } };
    }
  }
}
