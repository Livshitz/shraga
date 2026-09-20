import { afterAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import express from 'express';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSharer, FileSharerOptions, setSharedFileHeaders, shareMcpServer } from '../share-file.ts';
import { DATA_DIR } from '../paths.ts';
import { WORKSPACE_DIR } from '../workspace.ts';
import { profileAllowsTool, SHARE_TOOL_ID } from '../security/enforce.ts';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'share-file-')));
const data = path.join(base, 'data'), work = path.join(data, 'workspace'), outside = path.join(base, 'outside');
for (const d of [work, outside, path.join(data, 'conversations'), path.join(work, '.claude'), path.join(data, 'quarantine'), path.join(data, 'uploads', 'sess1')]) mkdirSync(d, { recursive: true });
const put = (p: string, c = 'x') => { writeFileSync(p, c); return p; };
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sharer = (origin = 'https://agent.example.com') => new FileSharer({ dataDir: data, roots: () => [work], origin: () => origin, maxBytes: 64 });
const DOT_ENV = ['', 'env'].join('.');

describe('FileSharer', () => {
  test('copies into uploads/shared under a random name and returns the absolute public URL', async () => {
    const src = put(path.join(work, 'ad v2.mp4'), 'VIDEO');
    const r = await sharer().share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toMatch(/^https:\/\/agent\.example\.com\/uploads\/shared\/[0-9a-f]{32}-ad-v2\.mp4$/);
    expect(r.path).toBe(path.join(data, 'uploads', 'shared', r.url.split('/').pop()!));
    expect(readFileSync(r.path, 'utf8')).toBe('VIDEO');
    expect(r.bytes).toBe(5);
    const again = await sharer().share(src);
    expect(again.ok && again.url).not.toBe(r.url);
  });

  test('custom name is sanitized (no traversal, no dotfile)', async () => {
    const r = await sharer().share(put(path.join(work, 'a.png')), '../../.evil name?.png');
    if (!r.ok) throw new Error(r.error);
    expect(path.dirname(r.path)).toBe(path.join(data, 'uploads', 'shared'));
    expect(r.url).toMatch(/\/[0-9a-f]{32}-evil-name-\.png$/);
  });

  test('no public origin: error telling the agent to attach instead', async () => {
    const r = await sharer('').share(put(path.join(work, 'b.png')));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('attachment');
  });

  const refused: [string, () => string, RegExp][] = [
    ['relative path', () => 'workspace/a.png', /absolute/],
    ['missing file', () => path.join(work, 'nope.mp4'), /No such file/],
    ['directory', () => work, /Not a regular file/],
    ['env file', () => put(path.join(work, DOT_ENV)), /secret/],
    ['.pem', () => put(path.join(work, 'x.pem')), /secret/],
    ['outside roots', () => put(path.join(outside, 'x.mp4')), /Only files under/],
    ['symlink escaping the roots', () => { const l = path.join(work, 'link.mp4'); symlinkSync(put(path.join(outside, 'y.mp4')), l); return l; }, /Only files under/],
    ['hidden dir', () => put(path.join(work, '.claude', 'settings.json')), /hidden/],
    ['server-owned data', () => put(path.join(data, 'conversations', 'c.json')), /Only files under/],
    ['quarantine', () => put(path.join(data, 'quarantine', 'q.json')), /Only files under/],
    ['users.json', () => put(path.join(data, 'users.json')), /secret|Only files under/],
    ['slack-tokens.json in the data dir', () => put(path.join(data, 'slack-tokens.json')), /secret|Only files under/],
    ['agent-config.json in the data dir', () => put(path.join(data, 'agent-config.json')), /Only files under/],
    ["another session's auth-protected upload", () => put(path.join(data, 'uploads', 'sess1', 'p.png')), /Only files under/],
    ['hardlink to a file outside the roots', () => { const t = put(path.join(outside, 'login.json'), 'SECRET'); const l = path.join(work, 'innocent.mp4'); linkSync(t, l); return l; }, /hard-linked/],
    ['id_ed25519', () => put(path.join(work, 'id_ed25519')), /secret/],
    ['credentials', () => put(path.join(work, 'credentials')), /secret/],
    ['token.json', () => put(path.join(work, 'token.json')), /secret/],
    ['push-tokens.json', () => put(path.join(work, 'push-tokens.json')), /secret/],
    ['file over the size cap', () => put(path.join(work, 'big.mp4'), 'x'.repeat(65)), /share limit/],
  ];
  for (const [name, mk, re] of refused) test(`refuses ${name}`, async () => {
    const r = await sharer().share(mk());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(re);
  });

  test('default roots are an allowlist: workspace only, never tmp or the whole data dir', () => {
    const roots = new FileSharerOptions().roots();
    expect(roots).toEqual([WORKSPACE_DIR]);
    expect(roots).not.toContain('/tmp');
    expect(roots).not.toContain(DATA_DIR);
    expect(new FileSharerOptions().maxBytes).toBe(500 * 1024 * 1024);
  });
});

describe('shared file serving headers (real express.static)', () => {
  const dir = path.join(base, 'served');
  mkdirSync(dir, { recursive: true });
  for (const n of ['x.html', 'x.svg', 'x.png', 'x.mp4', 'x.pdf']) put(path.join(dir, n), 'body');
  const app = express();
  app.use('/uploads/shared', express.static(dir, { dotfiles: 'deny', index: false, setHeaders: setSharedFileHeaders }));
  const server = app.listen(0);
  afterAll(() => server.close());
  const get = (n: string) => fetch(`http://127.0.0.1:${(server.address() as any).port}/uploads/shared/${n}`);

  for (const n of ['x.html', 'x.svg']) test(`${n} downloads in a sandbox, never renders as our origin`, async () => {
    const r = await get(n);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe('sandbox');
    expect(r.headers.get('content-disposition')).toBe('attachment');
  });
  for (const [n, type] of [['x.png', 'image/png'], ['x.mp4', 'video/mp4'], ['x.pdf', 'application/pdf']]) test(`${n} still renders inline`, async () => {
    const r = await get(n);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain(type);
    expect(r.headers.get('content-disposition')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // No `sandbox`: it would give the media document an opaque origin and Chrome's viewer would never load it.
    expect(r.headers.get('content-security-policy')).toBeNull();
  });
});

describe('share_file tool', () => {
  test('in-process SDK server; handler returns the URL or an error', async () => {
    const s = shareMcpServer(sharer());
    expect(s.type).toBe('sdk');
    expect(s.name).toBe('shraga-share');
    expect(SHARE_TOOL_ID).toBe('mcp__shraga-share__share_file');
    const tools = (s.instance as any)._registeredTools;
    const res = await tools.share_file.handler({ file_path: put(path.join(work, 'c.pdf')) }, {});
    expect(res.content[0].text).toMatch(/https:\/\/agent\.example\.com\/uploads\/shared\/[0-9a-f]{32}-c\.pdf/);
    const bad = await tools.share_file.handler({ file_path: '/etc/passwd' }, {});
    expect(bad.isError).toBe(true);
  });

  test('profile gate: full profiles only', () => {
    expect(profileAllowsTool({ tools: ['*'], mcps: ['*'] }, SHARE_TOOL_ID)).toBe(true);
    expect(profileAllowsTool({ tools: ['Read'], mcps: ['*'] }, SHARE_TOOL_ID)).toBe(false);
    expect(profileAllowsTool({ tools: ['escalate'], mcps: [] }, SHARE_TOOL_ID)).toBe(false);
  });
});
