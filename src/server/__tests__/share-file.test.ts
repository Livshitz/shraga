import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSharer, shareMcpServer } from '../share-file.ts';
import { profileAllowsTool, SHARE_TOOL_ID } from '../security/enforce.ts';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'share-file-')));
const data = path.join(base, 'data'), work = path.join(data, 'workspace'), outside = path.join(base, 'outside');
for (const d of [work, outside, path.join(data, 'conversations'), path.join(work, '.claude'), path.join(data, 'quarantine')]) mkdirSync(d, { recursive: true });
const put = (p: string, c = 'x') => { writeFileSync(p, c); return p; };
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sharer = (origin = 'https://agent.example.com') => new FileSharer({ dataDir: data, roots: () => [data, work], origin: () => origin });
const DOT_ENV = ['', 'env'].join('.');

describe('FileSharer', () => {
  test('copies into uploads/shared under a random name and returns the absolute public URL', () => {
    const src = put(path.join(work, 'ad v2.mp4'), 'VIDEO');
    const r = sharer().share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toMatch(/^https:\/\/agent\.example\.com\/uploads\/shared\/[0-9a-f]{32}-ad-v2\.mp4$/);
    expect(r.path).toBe(path.join(data, 'uploads', 'shared', r.url.split('/').pop()!));
    expect(readFileSync(r.path, 'utf8')).toBe('VIDEO');
    expect(r.bytes).toBe(5);
    const again = sharer().share(src);
    expect(again.ok && again.url).not.toBe(r.url);
  });

  test('custom name is sanitized (no traversal, no dotfile)', () => {
    const r = sharer().share(put(path.join(work, 'a.png')), '../../.evil name?.png');
    if (!r.ok) throw new Error(r.error);
    expect(path.dirname(r.path)).toBe(path.join(data, 'uploads', 'shared'));
    expect(r.url).toMatch(/\/[0-9a-f]{32}-evil-name-\.png$/);
  });

  test('no public origin: error telling the agent to attach instead', () => {
    const r = sharer('').share(put(path.join(work, 'b.png')));
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
    ['server-owned data', () => put(path.join(data, 'conversations', 'c.json')), /server-owned/],
    ['quarantine', () => put(path.join(data, 'quarantine', 'q.json')), /server-owned/],
    ['users.json', () => put(path.join(data, 'users.json')), /secret|server-owned/],
  ];
  for (const [name, mk, re] of refused) test(`refuses ${name}`, () => {
    const r = sharer().share(mk());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(re);
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
