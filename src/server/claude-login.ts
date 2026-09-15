/**
 * Web-UI Claude subscription login — connect / replace / disconnect without SSH.
 *
 * Drives the bundled CLI's `claude auth login` over plain pipes: it prints the OAuth URL and then reads
 * the pasted code from stdin, so one pending child per target waits between the two HTTP calls.
 * On Linux the login runs in a private temp CLAUDE_CONFIG_DIR and its credentials are installed into
 * the real target only after the CLI exits 0 — a failed Replace never breaks the working login.
 * macOS keeps credentials in a Keychain item keyed by the config dir (no file to move), so there the
 * login runs in place.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import * as contacts from './contacts.ts';
import { applyClaudeAccount } from './claude-account.ts';
import { WORKSPACE_DIR } from './workspace.ts';

const TAG = '[claude-login]';

export type ClaudeTargetName = 'me' | 'global';

export interface ClaudeTarget {
  key: string;
  name: ClaudeTargetName;
  /** CLAUDE_CONFIG_DIR the runs read — for `global` without an explicit env var, ~/.claude. */
  dir: string;
  /** Where the CLI writes `oauthAccount`: inside `dir` when CLAUDE_CONFIG_DIR is set, else ~/.claude.json. */
  accountFile: string;
  /** Whether runs set CLAUDE_CONFIG_DIR for this target (false only for an implicit global login). */
  explicitDir: boolean;
}

export interface ClaudeAccountStatus { connected: boolean; account: string | null; subscriptionType: string | null }

export class ClaudeLoginError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class ClaudeLoginOptions {
  cliPath: string = resolveClaudeCli();
  workspaceDir = WORKSPACE_DIR;
  findContact: (email: string) => { id: string } | null = email => contacts.find({ email });
  globalConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR;
  home = homedir();
  /** Install credentials from a temp dir on success (file-based platforms); darwin logs in place. */
  swap = process.platform !== 'darwin';
  sessionTtlMs = 10 * 60_000;
  urlTimeoutMs = 20_000;
  codeTimeoutMs = 60_000;
  /** Called after any change to the global login (usage reader cache). */
  onGlobalChange: () => void = () => {};
}

interface Pending { target: ClaudeTarget; child: ChildProcess; loginDir: string; output: () => string; exit: Promise<number | null>; timer: ReturnType<typeof setTimeout> }

export class ClaudeLogin {
  public options: ClaudeLoginOptions;
  private pending = new Map<string, Pending>();

  public constructor(options?: Partial<ClaudeLoginOptions>) {
    this.options = { ...new ClaudeLoginOptions(), ...options };
  }

  /** Authorization + target resolution. `me` needs a contact; `global` needs the owner. */
  resolve(name: string, user: { email?: string; isOwner?: boolean }): ClaudeTarget {
    const o = this.options;
    if (name === 'global') {
      if (!user.isOwner) throw new ClaudeLoginError(403, 'Only the owner can manage the shared Claude subscription');
      const dir = o.globalConfigDir || path.join(o.home, '.claude');
      return { key: 'global', name, dir, explicitDir: !!o.globalConfigDir, accountFile: o.globalConfigDir ? path.join(dir, '.claude.json') : path.join(o.home, '.claude.json') };
    }
    if (name !== 'me') throw new ClaudeLoginError(404, `Unknown target "${name}"`);
    const email = user.email?.trim().toLowerCase();
    const contact = email ? o.findContact(email) : null;
    if (!contact?.id) throw new ClaudeLoginError(409, `No contact matches ${email || 'your account'} — ask the owner to add you as a contact before connecting a personal subscription`);
    const dir = path.join(o.workspaceDir, 'users', contact.id, '.claude');
    return { key: `me:${contact.id}`, name, dir, explicitDir: true, accountFile: path.join(dir, '.claude.json') };
  }

  async status(target: ClaudeTarget): Promise<ClaudeAccountStatus> {
    const none = { connected: false, account: null, subscriptionType: null };
    if (target.name === 'me' && !(await exists(target.dir))) return none;
    try {
      const out = await this.run(['auth', 'status', '--json'], target.explicitDir ? target.dir : null);
      const s = JSON.parse(out);
      return { connected: !!s.loggedIn, account: s.email ?? null, subscriptionType: s.subscriptionType ?? null };
    } catch (err) {
      console.warn(`${TAG} status failed for ${target.key}:`, (err as Error).message);
      return none;
    }
  }

  /** Spawn `auth login`, return the OAuth URL. Replaces any pending login for the same target. */
  async start(target: ClaudeTarget): Promise<string> {
    this.cancel(target.key);
    const loginDir = this.options.swap ? await mkdtemp(path.join(tmpdir(), 'shraga-claude-login-')) : target.dir;
    if (!this.options.swap) await mkdir(loginDir, { recursive: true, mode: 0o700 });
    const child = spawn(this.options.cliPath, ['auth', 'login', '--claudeai'], { env: this.env(loginDir, true), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b: Buffer) => { out += b.toString(); };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const exit = new Promise<number | null>(res => { child.on('exit', code => res(code)); child.on('error', () => res(-1)); });
    const timer = setTimeout(() => { console.info(`${TAG} login for ${target.key} expired`); this.cancel(target.key); }, this.options.sessionTtlMs);
    timer.unref?.();
    const p: Pending = { target, child, loginDir, output: () => out, exit, timer };
    this.pending.set(target.key, p);

    const url = await new Promise<string | null>(resolve => {
      const check = () => { const u = parseLoginUrl(out); if (u) done(u); };
      const done = (u: string | null) => { clearTimeout(t); child.stdout!.off('data', check); child.stderr!.off('data', check); resolve(u); };
      const t = setTimeout(() => done(null), this.options.urlTimeoutMs);
      child.stdout!.on('data', check);
      child.stderr!.on('data', check);
      exit.then(() => done(parseLoginUrl(out)));
      check();
    });
    if (!url) {
      this.cancel(target.key);
      throw new ClaudeLoginError(502, `Claude CLI did not print a login URL: ${tail(out)}`);
    }
    return url;
  }

  /** Feed the pasted code; on success install credentials and return the fresh status. */
  async submitCode(target: ClaudeTarget, code: string): Promise<ClaudeAccountStatus> {
    const p = this.pending.get(target.key);
    if (!p) throw new ClaudeLoginError(404, 'No login in progress (it may have expired) — start again');
    if (!code?.trim()) throw new ClaudeLoginError(400, 'Code is required');
    this.pending.delete(target.key);
    clearTimeout(p.timer);
    try {
      p.child.stdin!.end(code.trim() + '\n');
      const exitCode = await Promise.race([p.exit, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), this.options.codeTimeoutMs))]);
      if (exitCode !== 0) {
        p.child.kill('SIGKILL');
        throw new ClaudeLoginError(400, `Login failed${exitCode === 'timeout' ? ' (timed out)' : ''}: ${tail(p.output())}`);
      }
      if (this.options.swap) await installLogin(p.loginDir, target);
    } finally {
      if (this.options.swap) await rm(p.loginDir, { recursive: true, force: true });
    }
    if (target.name === 'global') this.options.onGlobalChange();
    return this.status(target);
  }

  /** `me`: logout + remove the dir → runs fall back to the shared subscription. `global`: logout. */
  async disconnect(target: ClaudeTarget): Promise<void> {
    this.cancel(target.key);
    if (target.name === 'me' && !(await exists(target.dir))) return;
    try { await this.run(['auth', 'logout'], target.explicitDir ? target.dir : null); }
    catch (err) { console.warn(`${TAG} logout failed for ${target.key}:`, (err as Error).message); }
    if (target.name === 'me') await rm(target.dir, { recursive: true, force: true });
    else this.options.onGlobalChange();
  }

  cancel(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    p.child.kill('SIGKILL');
    if (this.options.swap) rm(p.loginDir, { recursive: true, force: true }).catch((err: Error) => console.warn(`${TAG} temp cleanup failed:`, err.message));
  }

  private env(dir: string | null, login = false): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (dir) applyClaudeAccount(env, dir);
    else { applyClaudeAccount(env, ''); delete env.CLAUDE_CONFIG_DIR; }
    if (login) env.BROWSER = 'true'; // never try to open a browser on the server
    return env;
  }

  private run(args: string[], dir: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.options.cliPath, args, { env: this.env(dir), timeout: 20_000 }, (err, stdout) => {
        // `auth status` exits 1 when logged out but still prints valid JSON.
        if (err && !stdout.trim()) reject(err); else resolve(stdout);
      });
    });
  }
}

/** The authorize URL from the CLI's "visit: <url>" line. */
export function parseLoginUrl(output: string): string | null {
  return output.match(/https:\/\/[^\s<>"']*oauth\/authorize[^\s<>"']*/)?.[0] ?? null;
}

/** Copy credential files + identity from a successful temp login into the target (atomic per file). */
export async function installLogin(loginDir: string, target: ClaudeTarget): Promise<void> {
  const creds = (await readdir(loginDir)).filter(n => /^\.credentials.*\.json$/.test(n));
  if (!creds.length) throw new ClaudeLoginError(500, 'Login succeeded but the CLI wrote no credentials file');
  await mkdir(target.dir, { recursive: true, mode: 0o700 });
  for (const name of creds) {
    const dest = path.join(target.dir, name);
    await copyFile(path.join(loginDir, name), dest + '.tmp');
    await rename(dest + '.tmp', dest);
  }
  const fresh = await readJson(path.join(loginDir, '.claude.json'));
  if (fresh.oauthAccount) {
    const current = await readJson(target.accountFile);
    await writeFile(target.accountFile + '.tmp', JSON.stringify({ ...current, oauthAccount: fresh.oauthAccount }, null, 2), { mode: 0o600 });
    await rename(target.accountFile + '.tmp', target.accountFile);
  }
}

/** The platform binary the Agent SDK itself spawns (same package lookup, musl first on musl Linux). */
export function resolveClaudeCli(): string {
  const require = createRequire(import.meta.url);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try { return require.resolve(`${pkg}/claude${ext}`); } catch { /* next */ }
  }
  return 'claude';
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
async function exists(p: string): Promise<boolean> {
  try { await readdir(p); return true; } catch { return false; }
}
function tail(s: string): string {
  return s.trim().split('\n').slice(-3).join(' ').slice(0, 300) || '(no output)';
}
