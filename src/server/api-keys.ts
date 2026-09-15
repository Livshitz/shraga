// API keys (`uck_…`). Stored as sha256(key) + a display preview — the plaintext is returned ONCE, by create().
//
// Migration (one-time, idempotent, at load): a file still holding plaintext `key` entries is hashed in place —
// the original bytes are kept at `<path>.bak` (mode 600, written only if absent), then the hashed file is written
// atomically (tmp + rename, mode 600). Only the ACTIVE instance migrates: a PASSIVE standby sharing DATA_DIR hashes
// in memory and serves the same keys without writing. A file with no plaintext entries is never rewritten.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.ts';
import { fromApiKey, fromAuthUser, type Principal } from './security/principal.ts';
import { OWNER_ROLE } from './security/policy.ts';
import { security } from './security/runtime.ts';

export interface ApiKey {
  id: string;
  /** sha256 hex of the full key. */
  hash: string;
  keyPreview: string;
  label: string;
  uid: string;
  email: string;
  createdAt: number;
  /** Policy role name the key's principal carries (never owner). */
  role?: string;
  /** Epoch ms; the key is rejected from then on. */
  expiresAt?: number;
}
export type ApiKeyView = Omit<ApiKey, 'hash'>;
export interface ApiKeyIdentity { id: string; uid: string; email: string; role?: string }
export interface CreateApiKeyOptions { role?: string; expiresAt?: number; /** Principal id of the creator, for the audit. */ actor?: string }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const previewOf = (key: string) => `${key.slice(0, 8)}…`;
const view = ({ hash: _h, ...rest }: ApiKey): ApiKeyView => rest;

export class ApiKeyStoreOptions {
  path: string = dataPath('api-keys.json');
  /** Migration writes only while true (PASSIVE standby ⇒ false). Default: the security runtime's flag. */
  isActive: () => boolean = () => security()?.options.isActive() ?? true;
  clock: () => number = Date.now;
  log: Pick<Console, 'info' | 'warn' | 'error'> = console;
}

interface Snapshot { mtimeMs: number; size: number; keys: ApiKey[]; byHash: Map<string, ApiKey>; legacy: boolean }

export class ApiKeyStore {
  public options: ApiKeyStoreOptions;
  private snap?: Snapshot;

  public constructor(options?: Partial<ApiKeyStoreOptions>) {
    this.options = { ...new ApiKeyStoreOptions(), ...options };
  }

  private active(): boolean {
    try { return this.options.isActive(); }
    catch (e: any) { this.options.log.error(`[api-keys] isActive threw — treating as PASSIVE: ${e.message}`); return false; }
  }

  /** Current keys; re-parses only when the file changed (stat), migrating plaintext entries on the active instance. */
  private read(): Snapshot {
    const p = this.options.path;
    const st = existsSync(p) ? statSync(p) : null;
    const s = this.snap;
    if (s && st && s.mtimeMs === st.mtimeMs && s.size === st.size && !(s.legacy && this.active())) return s;
    if (!st) return (this.snap = { mtimeMs: 0, size: -1, keys: [], byHash: new Map(), legacy: false });
    const raw = readFileSync(p, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e: any) {
      this.options.log.error(`[api-keys] ${p} unparseable — no keys valid until fixed: ${e.message}`);
      parsed = [];
    }
    let legacy = false;
    const keys: ApiKey[] = (Array.isArray(parsed) ? parsed : []).map((k: any) => {
      if (typeof k?.key !== 'string') return k as ApiKey;
      legacy = true;
      const { key, ...rest } = k;
      return { ...rest, hash: sha256(key), keyPreview: previewOf(key) };
    });
    if (legacy && this.active()) return this.migrate(raw, keys);
    return (this.snap = { mtimeMs: st.mtimeMs, size: st.size, keys, byHash: this.index(keys), legacy });
  }

  private index(keys: ApiKey[]): Map<string, ApiKey> {
    return new Map(keys.filter(k => typeof k?.hash === 'string').map(k => [k.hash, k]));
  }

  private migrate(raw: string, keys: ApiKey[]): Snapshot {
    const bak = `${this.options.path}.bak`;
    try {
      if (existsSync(bak)) this.options.log.warn(`[api-keys] ${bak} exists — keeping it, not overwriting`);
      else writeFileSync(bak, raw, { mode: 0o600, flag: 'wx' });
      const snap = this.write(keys);
      this.options.log.info(`[api-keys] migrated ${keys.length} key(s) to hashed storage (backup: ${bak})`);
      return snap;
    } catch (e: any) {
      this.options.log.error(`[api-keys] migration failed — serving hashed in memory, will retry: ${e.message}`);
      return (this.snap = { mtimeMs: -1, size: -1, keys, byHash: this.index(keys), legacy: true });
    }
  }

  /** Atomic write (tmp + rename, mode 600); refreshes the snapshot from what landed. */
  private write(keys: ApiKey[]): Snapshot {
    const p = this.options.path;
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
    const st = statSync(p);
    return (this.snap = { mtimeMs: st.mtimeMs, size: st.size, keys, byHash: this.index(keys), legacy: false });
  }

  /** Mint a key. Returns its public view plus the plaintext `key` — the only time it is ever available. */
  public create(uid: string, email: string, label: string, opts: CreateApiKeyOptions = {}): ApiKeyView & { key: string } {
    const { role, expiresAt, actor } = opts;
    if (role !== undefined) {
      if (typeof role !== 'string' || !role) throw new Error('role must be a non-empty string');
      if (role === OWNER_ROLE) throw new Error('an API key cannot carry the owner role');
      const policy = security()?.policy;
      if (policy && !policy.current.roles[role]) throw new Error(`role "${role}" is not defined in the policy`);
    }
    if (expiresAt !== undefined && !(Number.isFinite(expiresAt) && expiresAt > this.options.clock())) {
      throw new Error('expiresAt must be a future epoch (ms)');
    }
    const key = `uck_${randomBytes(32).toString('hex')}`;
    const entry: ApiKey = {
      id: randomBytes(8).toString('hex'), hash: sha256(key), keyPreview: previewOf(key), label, uid, email,
      createdAt: this.options.clock(), ...(role ? { role } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.write([...this.read().keys, entry]);
    security()?.record({
      type: 'key.create', principal: actor ?? fromAuthUser({ uid, email }).id, target: `apikey:${entry.id}`, role,
      meta: { uid, ...(expiresAt !== undefined ? { expiresAt } : {}) },
    });
    return { ...view(entry), key };
  }

  public delete(id: string, callerUid: string, isOwner: boolean, actor?: string): 'ok' | 'not_found' | 'forbidden' {
    const keys = this.read().keys;
    const k = keys.find(x => x.id === id);
    if (!k) return 'not_found';
    if (k.uid !== callerUid && !isOwner) return 'forbidden';
    this.write(keys.filter(x => x !== k));
    security()?.record({ type: 'key.revoke', principal: actor ?? `user:${callerUid}`, target: `apikey:${id}`, meta: { uid: k.uid } });
    return 'ok';
  }

  /** Keys visible to the caller: an owner sees every key, anyone else only their own. Never hash or plaintext. */
  public list(caller: { uid: string; isOwner: boolean }): ApiKeyView[] {
    return this.read().keys.filter(k => caller.isOwner || k.uid === caller.uid).map(view);
  }

  /** Hash lookup (the Map key is sha256 of the secret, so timing reveals nothing usable); expired ⇒ null. */
  public validate(key: string): ApiKeyIdentity | null {
    if (typeof key !== 'string' || !key.startsWith('uck_')) return null;
    const k = this.read().byHash.get(sha256(key));
    if (!k) return null;
    if (k.expiresAt !== undefined && this.options.clock() >= k.expiresAt) return null;
    return { id: k.id, uid: k.uid, email: k.email, ...(k.role ? { role: k.role } : {}) };
  }
}

let store: ApiKeyStore | undefined;
/** The process-wide store over data/api-keys.json. */
export const apiKeyStore = (): ApiKeyStore => (store ??= new ApiKeyStore());

export const createApiKey = (uid: string, email: string, label: string, opts?: CreateApiKeyOptions) => apiKeyStore().create(uid, email, label, opts);
export const deleteApiKey = (id: string, callerUid: string, isOwner: boolean, actor?: string) => apiKeyStore().delete(id, callerUid, isOwner, actor);
export const listApiKeys = (caller: { uid: string; isOwner: boolean }) => apiKeyStore().list(caller);
export const validateApiKey = (key: string) => apiKeyStore().validate(key);

/** Principal for a validated key. The key's role rides in `attrs.role` (principal.ts's fromApiKey takes no attrs). */
export function apiKeyPrincipal(k: ApiKeyIdentity): Principal {
  const p = fromApiKey(k);
  if (k.role) p.attrs.role = k.role;
  return p;
}
