import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveOffload, DEFAULT_OFFLOAD_MAX_LOCAL_FILE_MB } from '../shraga-config.ts';
import { buildOffloadContextBlock, heavyLocalCommand, isPublicUrl, offloadEnv, OffloadGateway, shouldOffloadShare } from '../offload.ts';
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
  test('share routing: media, oversize, or no origin → gateway; small non-media stays on the box', () => {
    expect(shouldOffloadShare('a.mp4', 2 * 1024 * 1024, undefined)).toBe(false);
    expect(shouldOffloadShare('a.pdf', 10, CFG)).toBe(false);
    expect(shouldOffloadShare('a.pdf', 2 * 1024 * 1024, CFG)).toBe(true);
    expect(shouldOffloadShare('a.mp4', 10, CFG)).toBe(true);
    expect(shouldOffloadShare('a.pdf', 10, CFG, false)).toBe(true);
  });
  test('prompt block tells the agent pod links must be public', () => {
    expect(buildOffloadContextBlock(CFG)).toContain('Slack/email attachment');
  });
  const publicUrls = ['https://circles-pod.taild06b03.ts.net/p/x', 'https://media.example.com/p/x', 'http://203.0.113.9:4700/p/x', 'https://8.8.8.8/p'];
  const privateUrls = ['http://100.83.37.11:4700/p/x', 'http://100.64.0.1/p', 'http://10.1.2.3/p', 'http://172.20.0.1/p', 'http://192.168.1.2/p', 'http://127.0.0.1:4700/p',
    'http://localhost:4700/p', 'http://circles-pod:4700/p', 'http://circles-pod.taild06b03.ts.net/p', 'http://[::1]/p', 'http://[fd7a:115c:a1e0::1]/p', 'http://169.254.1.1/p', 'http://pod.local/p', 'ftp://x.com/a', 'not a url'];
  for (const u of publicUrls) test(`public: ${u}`, () => expect(isPublicUrl(u)).toBe(true));
  for (const u of privateUrls) test(`not public: ${u}`, () => expect(isPublicUrl(u)).toBe(false));
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
    'ffmpeg -i in.mp4 -c:v libx264 out.mp4 > /dev/null',
    'ffmpeg -i in.mp4 -c:v libx264 out.mp4 >/dev/null 2>&1',
    'ffmpeg -i in.mp4 out.mp4 &> /dev/null',
    'ffmpeg -i in.mp4 -c:a copy out.mp4',
    "cat > run.sh <<'EOF'\necho hi\nEOF\nffmpeg -i a.mp4 b.mp4",
    'npx remotion render --log verbose a b',
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
    'ffmpeg -i a.mp4 -vn -acodec pcm_s16le audio.wav',
    'ffmpeg -y -i a.mp4 -vn -c:a copy audio.m4a',
    'ffmpeg -i a.mov voice.mp3',
    'ffmpeg -i a.mp4 -vn -c:a copy out.mka',
    "cat > build.sh <<'EOF'\nffmpeg -i a.mp4 -c:v libx264 b.mp4\nnpx remotion render x\nEOF",
    'cat <<-EOF > notes.md\n\tffmpeg -i a.mp4 b.mp4\n\tEOF',
    'npx remotion --help',
    'bunx remotion --version',
    'ffmpeg -i a.mp4 -f null - 2>&1 | tail -5',
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
  let publicBase: string | undefined = 'https://pod.test';
  let jobDone = true, ingestDelayMs = 0, mintHost = 'https://pod.test';
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body: any = req.method === 'POST' ? await req.json() : {};
      calls.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/media/health') return Response.json({ ok: false, publicBase });
      if (u.pathname === '/media/cancel') return Response.json({ ok: true, cancelled: body.jobId });
      if (u.pathname === '/media/ingest') {
        if (ingestDelayMs) await Bun.sleep(ingestDelayMs);
        // The gateway pulls from the agent's /uploads — the staged file must exist while it does.
        stagedSeen = existsSync(path.join(data, decodeURIComponent(body.source)));
        return Response.json({ ok: true, file: `/pod/${path.basename(body.source)}` });
      }
      if (u.pathname === '/media/preview' && body.file === '/pod/evicted.mp4') return Response.json({ ok: false, error: 'no such file' });
      if (u.pathname === '/media/preview') return Response.json({ ok: true, jobId: 'j1' });
      if (u.pathname === '/media/job') return Response.json({ ok: true, status: !jobDone || calls.filter(c => c.endsWith('/media/job')).length < 2 ? 'running' : 'done', result: { url: `${mintHost}/preview/j1` } });
      if (u.pathname === '/media/publish_url') return Response.json({ ok: true, url: `${mintHost}/p/${path.basename(body.file)}` });
      return Response.json({ ok: false, error: 'nope' }, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const gw = `http://localhost:${server.port}`;
  const sharer = (offload: typeof CFG | undefined, origin = 'https://agent.example.com', gwOpts = {}) => new FileSharer({
    dataDir: data, roots: () => [work], origin: () => origin, offload: () => offload,
    gateway: (cfg) => new OffloadGateway({ gateway: cfg.gateway, pollMs: 10, ...gwOpts }),
  });
  const BIG = Buffer.alloc(2 * 1024 * 1024, 1); // over CFG's 1MB cap
  const shared = () => existsSync(path.join(data, 'uploads', 'shared')) ? readdirSync(path.join(data, 'uploads', 'shared')) : [];

  test('large video → ingest + preview job → public preview URL; nothing left on the box', async () => {
    const src = path.join(work, 'ad.mp4'); writeFileSync(src, BIG);
    const r = await sharer({ ...CFG, gateway: gw }).share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe('https://pod.test/preview/j1');
    expect(stagedSeen).toBe(true);
    expect(calls).toEqual(['GET /media/health', 'POST /media/ingest', 'POST /media/preview', 'GET /media/job', 'GET /media/job']);
    expect(shared()).toEqual([]);
    expect(readdirSync(path.join(data, 'uploads'))).toEqual([]);
  });

  const sha = (b: Buffer) => new Bun.CryptoHasher('sha256').update(b).digest('hex');
  test('pod-copy sidecar with a matching sha → links the pod file, no re-upload', async () => {
    calls.length = 0;
    const src = path.join(work, 'gen.mp4'); writeFileSync(src, BIG);
    writeFileSync(`${src}.pod.json`, JSON.stringify({ podFile: '/pod/fal/gen_1.mp4', sha256: sha(BIG) }));
    const r = await sharer({ ...CFG, gateway: gw }).share(src);
    if (!r.ok) throw new Error(r.error);
    expect(calls).not.toContain('POST /media/ingest');
    expect(calls).toContain('POST /media/preview');
  });

  test('stale sidecar (file changed) or evicted pod file → normal ingest', async () => {
    for (const [podFile, digest] of [['/pod/fal/gen_1.mp4', 'deadbeef'], ['/pod/evicted.mp4', sha(BIG)]]) {
      calls.length = 0;
      const src = path.join(work, 'gen2.mp4'); writeFileSync(src, BIG);
      writeFileSync(`${src}.pod.json`, JSON.stringify({ podFile, sha256: digest }));
      const r = await sharer({ ...CFG, gateway: gw }).share(src);
      if (!r.ok) throw new Error(r.error);
      expect(calls).toContain('POST /media/ingest');
    }
  });

  test('large image → publish_url (works even with no public origin)', async () => {
    calls.length = 0;
    const src = path.join(work, 'still.png'); writeFileSync(src, BIG);
    const r = await sharer({ ...CFG, gateway: gw }, '').share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe('https://pod.test/p/still.png');
    expect(calls).toEqual(['GET /media/health', 'POST /media/ingest', 'POST /media/publish_url']);
  });

  test('small media goes to the gateway when its links are public', async () => {
    calls.length = 0;
    const src = path.join(work, 'clip.mp4'); writeFileSync(src, 'SMALLVIDEO');
    const r = await sharer({ ...CFG, gateway: gw }).share(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).not.toStartWith('https://agent.example.com/uploads/shared/');
    expect(calls.length).toBeGreaterThan(0);
  });

  test('small media falls back to the box when the gateway link is not public', async () => {
    calls.length = 0; publicBase = 'http://100.83.37.11:4700';
    try {
      const src = path.join(work, 'clip2.mp4'); writeFileSync(src, 'SMALLVIDEO');
      const r = await sharer({ ...CFG, gateway: gw }).share(src);
      if (!r.ok) throw new Error(r.error);
      expect(r.url).toStartWith('https://agent.example.com/uploads/shared/');
    } finally { publicBase = 'https://pod.test'; }
  });

  test('gateway advertises a tailnet publicBase → refused before any bytes move, no link', async () => {
    calls.length = 0; publicBase = 'http://100.83.37.11:4700';
    try {
      const src = path.join(work, 'big.mp4'); writeFileSync(src, BIG);
      const r = await sharer({ ...CFG, gateway: gw }).share(src);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.error).toContain('attachment'); expect(r.error).not.toContain('100.83'); }
      expect(calls).toEqual(['GET /media/health']);
    } finally { publicBase = 'https://pod.test'; }
  });

  test('no advertised base but the minted link is tailnet-only → refused, staging cleaned', async () => {
    calls.length = 0; publicBase = undefined; mintHost = 'http://100.83.37.11:4700';
    try {
      const src = path.join(work, 'big.pdf'); writeFileSync(src, BIG);
      const r = await sharer({ ...CFG, gateway: gw }).share(src);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('attachment');
      expect(readdirSync(path.join(data, 'uploads')).filter(d => d.startsWith('offload-'))).toEqual([]);
    } finally { publicBase = 'https://pod.test'; mintHost = 'https://pod.test'; }
  });

  test('preview job that outlives the wait is cancelled on the pod', async () => {
    calls.length = 0; jobDone = false;
    try {
      const src = path.join(work, 'slow.mp4'); writeFileSync(src, BIG);
      await expect(sharer({ ...CFG, gateway: gw }, undefined, { jobWaitMs: 60 }).share(src)).rejects.toThrow(/cancelled/);
      expect(calls.at(-1)).toBe('POST /media/cancel');
    } finally { jobDone = true; }
  });

  test('ingest request cap scales with file size (60s + 1s/MB), not the flat request cap', async () => {
    calls.length = 0; ingestDelayMs = 150;
    try {
      const src = path.join(work, 'doc.pdf'); writeFileSync(src, BIG);
      const r = await sharer({ ...CFG, gateway: gw }, undefined, { requestTimeoutMs: 50 }).share(src);
      if (!r.ok) throw new Error(r.error);
      expect(r.url).toBe('https://pod.test/p/doc.pdf');
    } finally { ingestDelayMs = 0; }
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
    await expect(bad.share(path.join(work, 'ad.mp4'))).rejects.toThrow(/offload gateway POST \/media\/ingest failed: 404/); // ad.mp4 is BIG
    expect(readdirSync(path.join(data, 'uploads')).filter(d => d.startsWith('offload-'))).toEqual([]);
  });
});
