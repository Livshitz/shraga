// `share_file` — the ONLY way the agent hands a user a link to a file. It copies the file into the public
// `uploads/shared` dir (boot.ts serves it unauthenticated) under an unguessable name and returns the absolute URL.
// Before this the agent built share URLs by hand and invented routes that fell through to the SPA shell.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { copyFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { DATA_DIR } from './paths.ts';
import { getPublicOrigin } from './shraga-config.ts';
import { WORKSPACE_DIR } from './workspace.ts';
import { PROTECTED_DATA_READ, PROTECTED_DATA_WRITE, SHARE_SERVER, SHARE_TOOL, touchesSecretPath } from './security/enforce.ts';

/** URL path boot.ts serves publicly from `<data>/uploads/shared`. */
export const SHARE_ROUTE = '/uploads/shared';

export class FileSharerOptions {
  dataDir: string = DATA_DIR;
  /** Directories a shared file must live under (resolved by realpath). */
  roots: () => string[] = () => [DATA_DIR, WORKSPACE_DIR, tmpdir(), '/tmp'];
  origin: () => string = getPublicOrigin;
}

export type ShareResult = { ok: true; url: string; path: string; bytes: number } | { ok: false; error: string };

const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
const within = (root: string, p: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

export class FileSharer {
  public constructor(public options?: Partial<FileSharerOptions>) {
    this.options = { ...new FileSharerOptions(), ...options };
  }

  private get o() { return this.options as FileSharerOptions; }

  /** Why this path may not be published, or undefined when it may. */
  public reject(filePath: string): string | undefined {
    if (!path.isAbsolute(filePath)) return 'file_path must be absolute.';
    const src = real(filePath);
    if (!src) return `No such file: ${filePath}`;
    if (!statSync(src).isFile()) return `Not a regular file: ${filePath}`;
    if (touchesSecretPath('Read', { file_path: filePath }) || touchesSecretPath('Read', { file_path: src })) return 'Refusing to publish a secret/credential file.';
    const roots = [...new Set(this.o.roots().map(real).filter((r): r is string => !!r))];
    const root = roots.filter(r => within(r, src)).sort((a, b) => b.length - a.length)[0];
    if (!root) return `Only files under ${this.o.roots().join(', ')} can be shared.`;
    // Hidden segments (.claude, .git, .ssh, …) hold config and credentials, never deliverables.
    if (path.relative(root, src).split(path.sep).some(s => s.startsWith('.'))) return 'Refusing to publish a file inside a hidden directory or a dotfile.';
    const data = real(this.o.dataDir);
    if (data && within(data, src)) {
      const rel = path.relative(data, src).split(path.sep).join('/').toLowerCase();
      if ([...PROTECTED_DATA_WRITE, ...PROTECTED_DATA_READ].some(e => (e.endsWith('/') ? rel.startsWith(e) : rel === e))) return 'Refusing to publish server-owned data.';
    }
    return undefined;
  }

  public share(filePath: string, name?: string): ShareResult {
    const origin = this.o.origin();
    if (!origin) return { ok: false, error: 'This deployment has no public origin, so no share link can be made. Send the file as an attachment instead (e.g. Slack file upload).' };
    const why = this.reject(filePath);
    if (why) return { ok: false, error: why };
    const src = realpathSync(filePath);
    const safe = (name || path.basename(src)).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-100) || 'file';
    const fileName = `${randomBytes(16).toString('hex')}-${safe}`;
    const dir = path.join(this.o.dataDir, 'uploads', 'shared');
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, fileName);
    copyFileSync(src, dest);
    const bytes = statSync(src).size;
    if (statSync(dest).size !== bytes) return { ok: false, error: `Copy to ${dest} is incomplete; do not send a link.` };
    return { ok: true, url: `${origin}${SHARE_ROUTE}/${encodeURIComponent(fileName)}`, path: dest, bytes };
  }
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
        file_path: z.string().min(1).describe('Absolute path of the file (under the data dir, workspace or tmp).'),
        name: z.string().max(200).optional().describe('Download name, e.g. "ad-v2.mp4". Defaults to the file name.'),
      },
      async ({ file_path, name }) => {
        let r: ShareResult;
        try { r = sharer.share(file_path, name); } catch (e) { r = { ok: false, error: `Share failed: ${(e as Error).message}` }; }
        if (!r.ok) console.warn(`[share] refused ${file_path}: ${r.error}`);
        else console.log(`[share] ${file_path} -> ${r.path} (${r.bytes} bytes)`);
        return r.ok
          ? { content: [{ type: 'text' as const, text: `Public link (send exactly this): ${r.url}` }] }
          : { content: [{ type: 'text' as const, text: r.error }], isError: true };
      },
    )],
  });
}
