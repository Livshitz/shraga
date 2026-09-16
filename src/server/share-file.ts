// `share_file` — the ONLY way the agent hands a user a link to a file. It copies the file into the public
// `uploads/shared` dir (boot.ts serves it unauthenticated) under an unguessable name and returns the absolute URL.
// Before this the agent built share URLs by hand and invented routes that fell through to the SPA shell.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { copyFile, stat, unlink } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod/v4';
import { DATA_DIR } from './paths.ts';
import { getOffload, getPublicOrigin, type OffloadSettings } from './shraga-config.ts';
import { OffloadGateway, shouldOffloadShare } from './offload.ts';
import { WORKSPACE_DIR } from './workspace.ts';
import { SHARE_SERVER, SHARE_TOOL, touchesSecretPath } from './security/enforce.ts';

/** URL path boot.ts serves publicly from `<data>/uploads/shared`. */
export const SHARE_ROUTE = '/uploads/shared';

export class FileSharerOptions {
  dataDir: string = DATA_DIR;
  /** ALLOWLIST of dirs agents write deliverables to (resolved by realpath). Never the whole data dir: it holds tokens,
   *  config and other sessions' auth-protected uploads. */
  roots: () => string[] = () => [WORKSPACE_DIR]; // not tmp: other processes' task outputs/credentials live there
  /** Largest file that may be published. */
  maxBytes: number = MAX_SHARE_BYTES;
  origin: () => string = getPublicOrigin;
  /** When set, media and files over `maxLocalFileMB` are shared through the offload gateway, not copied here. */
  offload: () => OffloadSettings | undefined = getOffload;
  gateway: (cfg: OffloadSettings) => OffloadGateway = (cfg) => new OffloadGateway({ gateway: cfg.gateway });
}

export const MAX_SHARE_BYTES = 500 * 1024 * 1024;

/** Key/token files with no telltale extension (the secret path patterns cover .env, .pem, .key, service accounts). */
const KEY_NAME_RE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|credentials?(?:[._-].*)?|tokens?(?:[._-].*)?|.*[._-]tokens?\.json)$/i;

export type ShareResult = { ok: true; url: string; path: string; bytes: number; offloaded?: boolean } | { ok: false; error: string };

const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
const within = (root: string, p: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

export class FileSharer {
  public constructor(public options?: Partial<FileSharerOptions>) {
    this.options = { ...new FileSharerOptions(), ...options };
  }

  private get o() { return this.options as FileSharerOptions; }

  /** Why this path may not be published, or the single realpath to copy from (no re-resolve between check and copy). */
  public check(filePath: string): { src: string; bytes: number } | { error: string } {
    if (!path.isAbsolute(filePath)) return { error: 'file_path must be absolute.' };
    const src = real(filePath);
    if (!src) return { error: `No such file: ${filePath}` };
    const st = statSync(src);
    if (!st.isFile()) return { error: `Not a regular file: ${filePath}` };
    if (touchesSecretPath('Read', { file_path: filePath }) || touchesSecretPath('Read', { file_path: src }) || KEY_NAME_RE.test(path.basename(src))) return { error: 'Refusing to publish a secret/credential file.' };
    // A hardlink shares its inode with a file elsewhere (e.g. the Claude CLI login) — realpath can't see that.
    if (st.nlink > 1) return { error: 'Refusing to publish a hard-linked file; copy it first.' };
    const roots = [...new Set(this.o.roots().map(real).filter((r): r is string => !!r))];
    const root = roots.filter(r => within(r, src)).sort((a, b) => b.length - a.length)[0];
    if (!root) return { error: `Only files under ${this.o.roots().join(', ')} can be shared.` };
    // Hidden segments (.claude, .git, .ssh, …) hold config and credentials, never deliverables.
    if (path.relative(root, src).split(path.sep).some(s => s.startsWith('.'))) return { error: 'Refusing to publish a file inside a hidden directory or a dotfile.' };
    if (st.size > this.o.maxBytes) return { error: `File is ${st.size} bytes; the share limit is ${this.o.maxBytes}. Compress it or send it another way.` };
    return { src, bytes: st.size };
  }

  public async share(filePath: string, name?: string): Promise<ShareResult> {
    const offload = this.o.offload();
    const origin = this.o.origin();
    if (!origin && !offload) return { ok: false, error: 'This deployment has no public origin, so no share link can be made. Send the file as an attachment instead (e.g. Slack file upload).' };
    const c = this.check(filePath);
    if ('error' in c) return { ok: false, error: c.error };
    const { src, bytes } = c;
    const safe = (name || path.basename(src)).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-100) || 'file';
    // Low-resource box: media/large files never land in uploads/shared — the gateway ingests and links them.
    if (shouldOffloadShare(safe, bytes, offload)) {
      return { ok: true, url: await this.o.gateway(offload!).share(src, this.o.dataDir, safe), path: src, bytes, offloaded: true };
    }
    if (!origin) return { ok: false, error: 'This deployment has no public origin, so no share link can be made for this file. Send it as an attachment instead (e.g. Slack file upload).' };
    const fileName = `${randomBytes(16).toString('hex')}-${safe}`;
    const dir = path.join(this.o.dataDir, 'uploads', 'shared');
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, fileName);
    await copyFile(src, dest);
    if ((await stat(dest)).size !== bytes) {
      await unlink(dest).catch(e => console.warn(`[share] cleanup of ${dest} failed: ${e}`));
      return { ok: false, error: `Copy to ${dest} is incomplete; do not send a link.` };
    }
    return { ok: true, url: `${origin}${SHARE_ROUTE}/${encodeURIComponent(fileName)}`, path: dest, bytes };
  }
}

/** Extensions a browser may render inline from our origin without running script. Everything else downloads. */
const INLINE_SAFE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.wav', '.ogg', '.pdf', '.txt']);

/** express.static `setHeaders` for SHARE_ROUTE (agent shares AND session-less user uploads). The auth token lives in
 *  same-origin localStorage, so a published .html/.svg must never execute here. */
export function setSharedFileHeaders(res: ServerResponse, filePath: string) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  if (!INLINE_SAFE_EXT.has(path.extname(filePath).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
}

/** In-process MCP server exposing `share_file` (full-access turns only; see engine/claude-code.ts). */
export function shareMcpServer(sharer = new FileSharer()) {
  return createSdkMcpServer({
    name: SHARE_SERVER,
    version: '1.0.0',
    tools: [tool(
      SHARE_TOOL,
      'Publish a local file (video, image, PDF, …) and get a public link to send the user. The ONLY valid way to make a file link — never construct share URLs by hand. Anyone with the link can open it (no login).',
      {
        file_path: z.string().min(1).describe('Absolute path of the file (must be under the workspace; move deliverables there first).'),
        name: z.string().max(200).optional().describe('Download name, e.g. "ad-v2.mp4". Defaults to the file name.'),
      },
      async ({ file_path, name }) => {
        let r: ShareResult;
        try { r = await sharer.share(file_path, name); } catch (e) { r = { ok: false, error: `Share failed: ${(e as Error).message}` }; }
        if (!r.ok) console.warn(`[share] refused ${file_path}: ${r.error}`);
        else console.log(`[share] ${file_path} -> ${r.offloaded ? `offload gateway ${r.url.split('?')[0]}` : r.path} (${r.bytes} bytes)`);
        return r.ok
          ? { content: [{ type: 'text' as const, text: `Public link (send exactly this): ${r.url}` }] }
          : { content: [{ type: 'text' as const, text: r.error }], isError: true };
      },
    )],
  });
}
