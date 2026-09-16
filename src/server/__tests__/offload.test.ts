import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveOffload, DEFAULT_OFFLOAD_MAX_LOCAL_FILE_MB } from '../shraga-config.ts';
import { buildOffloadContextBlock, heavyLocalCommand, offloadEnv, OffloadGateway, shouldOffloadShare } from '../offload.ts';
import { FileSharer } from '../share-file.ts';
import { buildHooks } from '../hooks.ts';

const CFG = { gateway: 'http://gw.test:4700', maxLocalFileMB: 1 };

describe('offload config', () => {
  test('unset / blank gateway → undefined', () => {
    expect(resolveOffload({})).toBeUndefined();
    expect(resolveOffload({ offload: { gateway: '  ' } })).toBeUndefined();
  });
  test('defaults maxLocalFileMB and trims trailing slash', () => {
    expect(resolveOffload({ offload: { gateway: 'http://x:1/' } })).toEqual({ gateway: 'http://x:1', maxLocalFileMB: DEFAULT_OFFLOAD_MAX_LOCAL_FILE_MB });
    expect(resolveOffload({ offload: { gateway: 'http://x', maxLocalFileMB: 5 } })!.maxLocalFileMB).toBe(5);
  });
  test('prompt block + env only when set', () => {
    expect(buildOffloadContextBlock(undefined)).toBe('');
    expect(offloadEnv(undefined)).toEqual({});
    expect(buildOffloadContextBlock(CFG)).toContain('<offload>');
    expect(buildOffloadContextBlock(CFG)).toContain(CFG.gateway);
    expect(offloadEnv(CFG)).toEqual({ SHRAGA_OFFLOAD: '1', SHRAGA_OFFLOAD_GATEWAY: CFG.gateway, SHRAGA_OFFLOAD_MAX_LOCAL_FILE_MB: '1' });
  });
  test('share routing', () => {
    expect(shouldOffloadShare('a.mp4', 10, undefined)).toBe(false);
    expect(shouldOffloadShare('a.mp4', 10, CFG)).toBe(true);
    expect(shouldOffloadShare('a.PNG', 10, CFG)).toBe(true);
    expect(shouldOffloadShare('a.pdf', 10, CFG)).toBe(false);
    expect(shouldOffloadShare('a.pdf', 2 * 1024 * 1024, CFG)).toBe(true);
  });
});

describe('heavy local command guard', () => {
  const heavy = [
    'ffmpeg -i in.mp4 -c:v libx264 out.mp4',
    'ffmpeg -y -i a.mov -vf scale=-2:720 b.mp4',
    'cd /x; timeout 600 ffmpeg -i a.mp4 b.webm',
    'FOO=1 nice -n 5 /usr/bin/ffmpeg -i a.mp4 -c copy -vf fps=30 b.mp4',
    'npx remotion render src/index.ts Main out.mp4',
    'bunx remotion still x',
    'npx --yes @remotion/cli render a b',
    'remotion render a b c',
    'echo hi && ffmpeg -i a.mp4 out.mkv',
    'bun run vendor/mcp-video/src/mcp/cli.ts --http',
    'nohup node /opt/x/mcp-audio/dist/server.js &',
  ];
  const cheap = [
    'grep -rn ffmpeg scripts/',
    'which ffmpeg',
    'ffprobe -v error -show_format a.mp4',
    'ffmpeg -version',
    'ffmpeg -i a.mp4 -af silencedetect -f null -',
    'ffmpeg -i a.mp4 -frames:v 1 thumb.png',
    'ffmpeg -i a.mp4 -c copy b.mp4',
    'ffmpeg -i a.mp4 -f rawvideo -pix_fmt gray -',
    'echo "ffmpeg -i a.mp4 b.mp4"',
    'cat remotion.config.ts',
    'ls vendor/mcp-video',
    'bun test vendor/mcp-video/src',
    'git commit -m "npx remotion render is refused"',
  ];
  for (const c of heavy) test(`refuses: ${c}`, () => expect(heavyLocalCommand(c)).not.toBeNull());
  for (const c of cheap) test(`allows: ${c}`, () => expect(heavyLocalCommand(c)).toBeNull());

  const bashDeny = (h: ReturnType<typeof buildHooks>) => h.PreToolUse!.some(m => m.hooks.some(x => x.name === 'denyHeavyLocalMedia' || String(x).includes('heavyLocalCommand')));
  test('hook wired only when offload is set', async () => {
    expect(bashDeny(buildHooks({ offload: undefined }))).toBe(false);
    const hooks = buildHooks({ offload: CFG });
    expect(bashDeny(hooks)).toBe(true);
    const run = async (command: string) => {
      for (const m of hooks.PreToolUse!) for (const h of m.hooks) {
        const r: any = await h({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, run_in_background: true } } as any, undefined, { signal: new AbortController().signal });
        if (r?.hookSpecificOutput?.permissionDecision === 'deny') return r.hookSpecificOutput.permissionDecisionReason as string;
      }
      return null;
    };
    expect(await run('ffmpeg -i a.mp4 b.mp4')).toContain(CFG.gateway);
    expect(await run('ffprobe a.mp4')).toBeNull();
  });
});

describe('share_file via offload gateway (stub)', () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'offload-')));
  const data = path.join(base, 'data'), work = path.join(data, 'workspace');
  mkdirSync(work, { recursive: true });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const calls: string[] = [];
  let stagedSeen = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body: any = req.method === 'POST' ? await req.json() : {};
      calls.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/media/ingest') {
        // The gateway pulls from the agent's /uploads — the staged file must exist while it does.
        stagedSeen = existsSync(path.join(data, decodeURIComponent(body.source)));
        return Response.json({ ok: true, file: `/pod/${path.basename(body.source)}` });
      }
      if (u.pathname === '/media/preview') return Response.json({ ok: true, jobId: 'j1' });
      if (u.pathname === '/media/job') return Response.json({ ok: true, status: calls.filter(c => c.endsWith('/media/job')).length < 2 ? 'running' : 'done', result: { url: 'https://pod.test/preview/j1' } });
      if (u.pathname === '/media/publish_url') return Response.json({ ok: true, url: `https://pod.test/p/${path.basename(body.file)}` });
      return Response.json({ ok: false, error: 'nope' }, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const gw = `http://localhost:${server.port}`;
  const sharer = (offload: typeof CFG | undefined, origin = 'https://agent.example.com') => new FileSharer({
    dataDir: data, roots: () => [work], origin: () => origin, offload: () => offload,
    gateway: (cfg) => new OffloadGateway({ gateway: cfg.gateway, pollMs: 10 }),
  });
  const shared = () => existsSync(path.join(data, 'uploads', 'shared')) ? readdirSync(path.join(data, 'uploads', 'shared')) : [];

  test('video → ingest + preview job → preview URL; nothing left on the box', async () => {
    const src = path.join(work, 'ad.mp4'); writeFileSync(src, 'VIDEO');
    const r = await sharer({ ...CFG, gateway: gw }).share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe('https://pod.test/preview/j1');
    expect(stagedSeen).toBe(true);
    expect(calls).toEqual(['POST /media/ingest', 'POST /media/preview', 'GET /media/job', 'GET /media/job']);
    expect(shared()).toEqual([]);
    expect(readdirSync(path.join(data, 'uploads'))).toEqual([]);
  });

  test('image → publish_url (works even with no public origin)', async () => {
    calls.length = 0;
    const src = path.join(work, 'still.png'); writeFileSync(src, 'PNG');
    const r = await sharer({ ...CFG, gateway: gw }, '').share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe('https://pod.test/p/still.png');
    expect(calls).toEqual(['POST /media/ingest', 'POST /media/publish_url']);
  });

  test('small doc stays local when offload is set', async () => {
    calls.length = 0;
    const src = path.join(work, 'notes.pdf'); writeFileSync(src, 'PDF');
    const r = await sharer({ ...CFG, gateway: gw }).share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toStartWith('https://agent.example.com/uploads/shared/');
    expect(calls).toEqual([]);
  });

  test('unset config → video is shared locally, gateway never called', async () => {
    calls.length = 0;
    const r = await sharer(undefined).share(path.join(work, 'ad.mp4'));
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toStartWith('https://agent.example.com/uploads/shared/');
    expect(calls).toEqual([]);
  });

  test('gateway failure surfaces as an error and cleans staging', async () => {
    const bad = new FileSharer({ dataDir: data, roots: () => [work], origin: () => 'https://a', offload: () => CFG, gateway: () => new OffloadGateway({ gateway: `${gw}/nope` }) });
    await expect(bad.share(path.join(work, 'ad.mp4'))).rejects.toThrow(/offload gateway POST \/media\/ingest failed: 404/);
    expect(readdirSync(path.join(data, 'uploads')).filter(d => d.startsWith('offload-'))).toEqual([]);
  });
});
