// Offload — a deployment whose box is too small for heavy work (media generation/render/encode, large files)
// declares `offload: { gateway }` in shraga.config.ts, and core then (1) tells the agent in its prompt,
// (2) routes share_file's media/large files through the gateway, (3) refuses clearly heavy local Bash commands.
// Unset config = none of this happens.
//
// GATEWAY CONTRACT (the config's interface — any service implementing these works; plain JSON over HTTP, the
// gateway authenticates this box however it likes, e.g. network identity — no credential is sent from here):
//   POST {gateway}/media/ingest       { source: '/uploads/<dir>/<file>' }  → { file } | { async: true, jobId }
//        The gateway pulls `source` from THIS agent's authenticated `/uploads` route.
//   GET  {gateway}/media/job?jobId=…                                       → { status: queued|running|done|failed|cancelled, result?, error? }
//        An async ingest's `result.file` is the gateway-side path.
//   POST {gateway}/media/preview      { file, expiresHours? }              → { jobId }  (job result.url = human preview link)
//   POST {gateway}/media/publish_url  { file, expiresHours? }              → { url }    (link to the original bytes)
// Every response may carry `ok: false` + `error`.
import { randomUUID } from 'node:crypto';
import { linkSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getOffload, type OffloadSettings } from './shraga-config.ts';

export type { OffloadSettings };

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.heic']);

export type MediaKind = 'video' | 'audio' | 'image';
export function mediaKind(file: string): MediaKind | undefined {
  const ext = path.extname(file).toLowerCase();
  return VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : IMAGE_EXT.has(ext) ? 'image' : undefined;
}

/** Whether share_file must hand this file to the gateway instead of publishing it from the box. */
export function shouldOffloadShare(file: string, bytes: number, cfg: OffloadSettings | undefined): boolean {
  return !!cfg && (!!mediaKind(file) || bytes > cfg.maxLocalFileMB * 1024 * 1024);
}

export class OffloadGatewayOptions {
  gateway = '';
  /** Cap for a single request. Bun's fetch otherwise cuts every request at an implicit 300s. */
  requestTimeoutMs = 60_000;
  /** Overall wait for an async ingest / preview job. */
  jobWaitMs = 20 * 60_000;
  pollMs = 3_000;
  /** Preview/link lifetime asked of the gateway. */
  expiresHours = 48;
  fetch: typeof fetch = fetch;
}

/** Minimal HTTP client for the gateway contract above. */
export class OffloadGateway {
  public constructor(public options?: Partial<OffloadGatewayOptions>) {
    this.options = { ...new OffloadGatewayOptions(), ...options };
  }

  private get o() { return this.options as OffloadGatewayOptions; }

  public async api(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Record<string, any>> {
    const url = `${this.o.gateway.replace(/\/+$/, '')}${route}`;
    const init = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      timeout: false, signal: AbortSignal.timeout(this.o.requestTimeoutMs), // explicit cap replaces Bun's implicit 300s
    };
    const res = await this.o.fetch(url, init as RequestInit);
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || json.ok === false) throw new Error(`offload gateway ${method} ${route} failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
    return json;
  }

  /** Poll a job to `done` and return its result. */
  public async waitJob(jobId: string): Promise<Record<string, any>> {
    for (const end = Date.now() + this.o.jobWaitMs; Date.now() < end;) {
      const j = await this.api('GET', `/media/job?jobId=${encodeURIComponent(jobId)}`);
      if (j.status === 'done') return (j.result ?? {}) as Record<string, any>;
      if (j.status === 'failed' || j.status === 'cancelled') throw new Error(`offload job ${jobId} ${j.status}: ${j.error ?? 'no error given'}`);
      await Bun.sleep(this.o.pollMs);
    }
    throw new Error(`offload job ${jobId} did not finish within ${Math.round(this.o.jobWaitMs / 60_000)}min`);
  }

  /** Have the gateway pull an agent `/uploads/...` path; returns the gateway-side file. */
  public async ingest(source: string): Promise<string> {
    let r = await this.api('POST', '/media/ingest', { source });
    if (r.async) r = await this.waitJob(String(r.jobId));
    if (!r.file) throw new Error(`offload ingest of ${source} returned no file: ${JSON.stringify(r)}`);
    return String(r.file);
  }

  /** Link for a gateway-side file: a transcoded preview for video, the original bytes otherwise. */
  public async link(file: string, kind: MediaKind | undefined): Promise<string> {
    const expiresHours = this.o.expiresHours;
    if (kind === 'video') {
      const { jobId } = await this.api('POST', '/media/preview', { file, expiresHours });
      const r = await this.waitJob(String(jobId));
      if (!r.url) throw new Error(`offload preview of ${file} returned no url: ${JSON.stringify(r)}`);
      return String(r.url);
    }
    const r = await this.api('POST', '/media/publish_url', { file, expiresHours });
    if (!r.url) throw new Error(`offload publish_url of ${file} returned no url: ${JSON.stringify(r)}`);
    return String(r.url);
  }

  /** Stage `src` under `<dataDir>/uploads/<id>/` (hardlink, copy fallback), let the gateway ingest it, drop the
   *  staging, and return a link. The staging exists only for the ingest, so the box's disk does not keep a copy. */
  public async share(src: string, dataDir: string, name: string): Promise<string> {
    const id = `offload-${randomUUID()}`;
    const dir = path.join(dataDir, 'uploads', id);
    mkdirSync(dir, { recursive: true });
    try {
      const staged = path.join(dir, name);
      try { linkSync(src, staged); } catch { copyFileSync(src, staged); }
      const file = await this.ingest(`/uploads/${id}/${encodeURIComponent(name)}`);
      return await this.link(file, mediaKind(name));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Env handed to agent subprocesses so scripts can tell they run on an offloading box. Empty when unset. */
export function offloadEnv(cfg = getOffload()): Record<string, string> {
  return cfg ? { SHRAGA_OFFLOAD: '1', SHRAGA_OFFLOAD_GATEWAY: cfg.gateway, SHRAGA_OFFLOAD_MAX_LOCAL_FILE_MB: String(cfg.maxLocalFileMB) } : {};
}

/** Prompt block for an offloading deployment. Empty when offload is unset. */
export function buildOffloadContextBlock(cfg = getOffload()): string {
  if (!cfg) return '';
  return [
    '<offload>',
    `This box is LOW-RESOURCE. Heavy work runs on an external pod behind the gateway ${cfg.gateway} (use its MCP tools).`,
    `- Generation, rendering, encoding/transcoding, large downloads, and any file over ${cfg.maxLocalFileMB}MB go through the gateway tools — never locally.`,
    '- Never run local ffmpeg encodes or remotion renders, and never hand-start media servers (mcp-video/mcp-audio) here; such Bash commands are refused. ffprobe and analysis are fine.',
    '- To share media, use the gateway\'s preview tool, or share_file (it routes media and large files through the gateway).',
    '</offload>',
  ].join('\n');
}

// ── Heavy-command guard ─────────────────────────────────────────────────────────────────────────────

/** Split a shell command into simple-command word lists on unquoted `; & | \n` (quote-aware, not a full shell parser;
 *  `bash -c "…"` / `$(…)` are not unpacked — this is a guardrail against the obvious, not a sandbox). */
export function shellSegments(cmd: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [], word = '', quote: string | null = null, inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i]; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; inWord = true; }
    else if (c === '\\' && i + 1 < cmd.length) { word += cmd[++i]; inWord = true; }
    else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') endSeg();
    else if (/\s/.test(c)) endWord();
    else { word += c; inWord = true; }
  }
  endSeg();
  return segs;
}

const WRAPPERS = new Set(['sudo', 'nice', 'nohup', 'exec', 'time', 'command', 'env', 'timeout']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const IMAGE_OUT = /\.(png|jpe?g|bmp|ppm|webp|gif|tiff?)$/i;

/** ffmpeg argv (no binary) that encodes/transcodes a real output — vs analysis, stream copy, frame grabs, stdout. */
function heavyFfmpeg(args: string[]): boolean {
  if (args.length === 0 || args.some(a => a === '-h' || a === '-version' || a.startsWith('-help') || a === '-encoders' || a === '-codecs')) return false;
  const val = (...flags: string[]) => { const i = args.findIndex(a => flags.includes(a)); return i >= 0 ? args[i + 1] : undefined; };
  if (val('-f') === 'null') return false;
  if (['-c', '-codec', '-c:v', '-vcodec'].some(f => val(f) === 'copy') && !args.includes('-vf') && !args.includes('-filter_complex')) return false;
  const frames = Number(val('-frames:v', '-vframes'));
  if (Number.isFinite(frames) && frames <= 2) return false;
  const out = args[args.length - 1]!;
  return !(out === '-' || out.startsWith('pipe:') || out === '/dev/null' || IMAGE_OUT.test(out));
}

/** Why `cmd` is refused on an offloading box, or null. */
export function heavyLocalCommand(cmd: string): string | null {
  for (let words of shellSegments(cmd)) {
    // Drop leading VAR=val assignments and wrappers (`timeout 60`, `sudo`, `nice -n 5`…).
    for (;;) {
      const w = words[0];
      if (w && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { words = words.slice(1); continue; }
      if (!w || !WRAPPERS.has(w)) break;
      words = words.slice(1);
      while (words[0] && (words[0].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(words[0]))) words = words.slice(1);
    }
    const bin = path.basename(words[0] ?? '');
    let rest = words.slice(1);
    if (RUNNERS.has(bin) || ((bin === 'bun' || bin === 'pnpm' || bin === 'yarn') && rest[0] === 'x')) {
      if (bin !== 'npx' && bin !== 'bunx' && bin !== 'pnpx') rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
      if (/^(@remotion\/cli|remotion)(@.*)?$/.test(rest[0] ?? '')) return 'a remotion command';
      if (rest[0] === 'ffmpeg' && heavyFfmpeg(rest.slice(1))) return 'an ffmpeg encode';
      continue;
    }
    if (bin === 'ffmpeg' && heavyFfmpeg(rest)) return 'an ffmpeg encode';
    if (bin === 'remotion' && /^(render|still|benchmark|lambda|cloudrun)$/.test(rest[0] ?? '')) return 'a remotion render';
    if (/^(bun|node|tsx|deno)$/.test(bin) && rest[0] !== 'test' && rest.some(a => /(^|\/)mcp-(video|audio)(\/|$)/.test(a))) return 'starting a media server (mcp-video/mcp-audio)';
  }
  return null;
}

export function heavyCommandDenyMessage(what: string, cfg: OffloadSettings): string {
  return `Refused: ${what} on this low-resource box. Heavy media work runs on the offload pod behind ${cfg.gateway} — use its gateway MCP tools (submit a job / preview), or share_file for sharing media. ffprobe and analysis commands are allowed.`;
}
