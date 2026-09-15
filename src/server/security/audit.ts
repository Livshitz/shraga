// Audit: append-only, hash-chained JSONL log at data/audit/YYYY-MM.jsonl (UTC month).
//
// Each line = {ts, type, principal?, role?, sessionId?, target?, reason?, meta?, prevHash, hash} where
// hash = sha256(prevHash + canonical(line without hash)) and canonical = JSON with keys sorted recursively.
// The chain is ONE chain across months and restarts: on construct the last hash is recovered by reading the
// newest file backwards from its end (never the whole file). The first-ever line carries GENESIS_HASH.
// Head state is shared per resolved dir within the process, so several Audit instances on one dir append to one chain.
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
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs';
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
 * Sanitization is best-effort defence, never a licence to pass raw payloads:
 * - keys naming secrets (token, secret, passw, authorization, cookie, credential, api-key(s), private-key, session-key,
 *   *key) or content (prompt, body, content, text, message(s), input, output) are STRIPPED at any depth; `keyId` stays.
 * - `[name, value]` tuples whose name is a secret key get the value redacted (header arrays).
 * - EVERY string (top-level fields, meta values, array items) is scanned: credential-looking values (Bearer/Basic,
 *   sk-…, xox?-…, JWT, PEM keys) become '[redacted]'; URL query params named like token/key/secret/sig/password/code
 *   keep the name with a redacted value.
 * - every string is truncated to `maxString`; meta depth ≤ 4, arrays ≤ 50 items;
 *   serialized meta over `maxMetaBytes` is replaced by `{ _truncated: true, keys }`.
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
const SECRET_KEY_RE = /token|secret|passw|authorization|cookie|credential|api[-_]?keys?|private[-_]?key|session[-_]?key|key$/i;
const CONTENT_KEY_RE = /prompt|body|content|^(text|messages?|input|output)$/i;
const CRED_PATTERNS = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}|\bsk-[A-Za-z0-9_-]{10,}|\bxox[a-z]-|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [^-]*KEY-----/i;
const URL_PARAM_RE = /([?&][^=&#\s]*(?:token|key|secret|sig|passw|code)[^=&#\s]*=)[^&#\s]*/gi;
const CHUNK = 64 * 1024;
const MAX_QUERY = 1000;

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
/** 'YYYY-MM' shifted by `d` months. */
const shiftMonth = (month: string, d: number) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + d, 1)).toISOString().slice(0, 7);

/** Chain head per resolved dir, shared by every Audit instance in the process. */
interface Head { lastHash: string; lastMonth: string; healthy: boolean }
const heads = new Map<string, Head>();

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
    const key = path.resolve(this.options.dir);
    this.state = heads.get(key) ?? { lastHash: GENESIS_HASH, lastMonth: '', healthy: true };
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
      if (files.length && sealTail(path.join(this.options.dir, files[files.length - 1]))) {
        this.options.log.warn(`[audit] sealed partial last line in ${files[files.length - 1]}`);
      }
      found: for (const f of [...files].reverse()) {
        for (const { line } of reverseLines(path.join(this.options.dir, f))) {
          const r = parse(line);
          if (r) { hash = r.hash; break found; }
          this.options.log.warn(`[audit] skipping unparseable tail line in ${f}`);
        }
      }
      s.lastHash = hash; s.lastMonth = files.length ? files[files.length - 1].slice(0, 7) : ''; s.healthy = true;
    } catch (e: any) {
      s.healthy = false;
      this.options.log.error(`[audit] chain recovery failed (${this.options.dir}), appends disabled until it succeeds: ${e.message}`);
    }
  }

  /** Redact credential-looking values, then truncate. */
  private str(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    const raw = String(v);
    const s = CRED_PATTERNS.test(raw) ? '[redacted]' : raw.replace(URL_PARAM_RE, '$1[redacted]');
    return s.length > this.options.maxString ? `${s.slice(0, this.options.maxString)}…` : s;
  }

  private clean(v: unknown, depth: number): unknown {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return this.str(v);
    if (depth >= 4) return '[depth]';
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'string' && SECRET_KEY_RE.test(v[0])) return [this.str(v[0]), '[redacted]'];
      return v.slice(0, 50).map(x => this.clean(x, depth + 1));
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!SECRET_KEY_RE.test(k) && !CONTENT_KEY_RE.test(k) && x !== undefined) out[k] = this.clean(x, depth + 1);
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

  /** Append one event. Never throws; returns the written record, or null on failure. */
  public append(event: AuditEvent): AuditRecord | null {
    let file: string | undefined;
    const s = this.state;
    try {
      if (!TYPES.has(event?.type)) throw new Error(`unknown audit type "${event?.type}"`);
      if (!s.healthy) this.recover();
      if (!s.healthy) throw new Error('audit dir unreadable; chain head unknown');
      const now = new Date(this.options.clock());
      const month = [now.toISOString().slice(0, 7), s.lastMonth].sort()[1];
      const base = { ts: now.toISOString(), type: event.type } as Omit<AuditRecord, 'hash'>; // prevHash set last, for line readability
      const opt = { principal: this.str(event.principal), role: this.str(event.role), sessionId: this.str(event.sessionId), target: this.str(event.target), reason: this.str(event.reason), meta: this.sanitize(event.meta) };
      for (const [k, v] of Object.entries(opt)) if (v !== undefined) (base as any)[k] = v;
      base.prevHash = s.lastHash;
      const rec: AuditRecord = { ...base, hash: hashOf(base) };
      mkdirSync(this.options.dir, { recursive: true });
      file = path.join(this.options.dir, `${month}.jsonl`);
      appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      s.lastHash = rec.hash; s.lastMonth = month;
      return rec;
    } catch (e: any) {
      this._failures++;
      this.options.log.error(`[audit] append failed (${event?.type}): ${e.message}`);
      if (file) try { sealTail(file); } catch (e2: any) { this.options.log.error(`[audit] could not seal ${file}: ${e2.message}`); }
      return null;
    }
  }

  /** Newest first, streaming backwards over the month files in range. Cursor is opaque (file + byte offset). */
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
    // Files are pruned by month with one month of slack either side (clock skew puts records in a neighbouring
    // month's file); each record is still filtered by its own ts.
    const maxMonth = to && shiftMonth(to.slice(0, 7), 1), minMonth = from && shiftMonth(from.slice(0, 7), -1);
    const items: AuditRecord[] = [];
    let last: { file: string; start: number } | undefined;
    for (const f of this.files().reverse()) {
      const month = f.slice(0, 7);
      if (cur && f > cur.file) continue;
      if (maxMonth && month > maxMonth) continue;
      if (minMonth && month < minMonth) break;
      for (const { line, start } of reverseLines(path.join(this.options.dir, f), cur?.file === f ? cur.offset : undefined)) {
        const r = parse(line);
        if (!r || (from && r.ts < from) || (to && r.ts > to) || (types && !types.has(r.type)) || (q.principal !== undefined && r.principal !== q.principal)) continue;
        if (items.length === limit) return { items, nextCursor: Buffer.from(`${last!.file}:${last!.start}`).toString('base64url') };
        items.push(r); last = { file: f, start };
      }
    }
    return { items };
  }

  /** Recompute the chain. No file = all files as one chain; a file = that file, seeded from the previous file's tail. */
  public verify(file?: string): AuditVerify {
    let all: string[];
    try { all = this.files(); } catch { return { ok: false, lines: 0, brokenAt: { file: '', line: 0, reason: 'unreadable' } }; }
    let targets = all, expected = GENESIS_HASH, lines = 0;
    if (file) {
      const base = path.basename(file), i = all.indexOf(base);
      if (i === -1) return { ok: false, lines: 0, brokenAt: { file: base, line: 0, reason: 'unparseable' } };
      targets = [base];
      for (let j = i - 1; j >= 0 && expected === GENESIS_HASH; j--) {
        for (const { line } of reverseLines(path.join(this.options.dir, all[j]))) { const r = parse(line); if (r) { expected = r.hash; break; } }
      }
    }
    for (const f of targets) {
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
  }
}
