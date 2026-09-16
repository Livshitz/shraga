// Offload — a deployment whose box is too small for heavy work (media generation/render/encode, large files)
// declares `offload: { gateway }` in shraga.config.ts, and core then (1) tells the agent in its prompt,
// (2) routes share_file's media/large files through the gateway, (3) refuses clearly heavy local Bash commands.
// Unset config = none of this happens.
//
// GATEWAY CONTRACT (the config's interface — any service implementing these works; plain JSON over HTTP, the
// gateway authenticates this box however it likes, e.g. network identity — no credential is sent from here):
//   POST {gateway}/media/ingest       { source: '/uploads/<dir>/<file>' }  → { file } | { async: true, jobId }
//        The gateway pulls `source` from THIS agent's authenticated `/uploads` route.
//   GET  {gateway}/media/health                                             → { publicBase? }  (origin minted links use; optional)
//   GET  {gateway}/media/job?jobId=…                                       → { status: queued|running|done|failed|cancelled, result?, error? }
//        An async ingest's `result.file` is the gateway-side path.
//   POST {gateway}/media/preview      { file, expiresHours? }              → { jobId }  (job result.url = human preview link)
//   POST {gateway}/media/publish_url  { file, expiresHours? }              → { url }    (link to the original bytes)
//   POST {gateway}/media/cancel       { jobId }                            (called when a job outlives our wait)
// Every response may carry `ok: false` + `error`.
// POD-COPY SIDECAR: a box file pulled FROM the gateway may sit next to `<file>.pod.json` = { podFile, sha256 }.
// When the sha still matches, share_file links the gateway's own copy instead of re-uploading the bytes it
// already holds; a stale sidecar or a failed link (file evicted on the pod) falls back to the normal ingest.
// share_file only hands out a gateway link a human can open: a private/tailnet link is refused (see isPublicUrl).
import { randomUUID } from 'node:crypto';
import { linkSync, copyFileSync, mkdirSync, rmSync, createReadStream, readFileSync, existsSync } from 'node:fs';
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

/** Whether share_file should hand this file to the gateway instead of publishing it from the box: media (a pod link
 *  keeps big bytes off a low-resource disk), files over the cap, or anything when the box has no public origin.
 *  A gateway refusal for a non-public link falls back to the box for files within the cap (see share-file.ts). */
export function shouldOffloadShare(file: string, bytes: number, cfg: OffloadSettings | undefined, hasOrigin = true): boolean {
  return !!cfg && (bytes > cfg.maxLocalFileMB * 1024 * 1024 || !!mediaKind(file) || !hasOrigin);
}

/** Whether a link is reachable by an arbitrary recipient (a Slack teammate, an external) — not loopback, a private
 *  LAN (RFC1918 / link-local / ULA), the tailnet (100.64.0.0/10 CGNAT, http MagicDNS), or a bare/`.local` host.
 *  `https://*.ts.net` counts as public: that is Tailscale Funnel. */
export function isPublicUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (host.includes(':')) return !(host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'));
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  if (host.endsWith('.ts.net')) return u.protocol === 'https:';
  return true;
}

export const OFFLOAD_PRIVATE_LINK_ERROR = 'This file is too large to share from this box, and the media pod has no public link origin yet (its links only open on the private network), so no link was made. Send the file as a Slack/email attachment instead, or ask an operator to publish it.';

export class OffloadGatewayOptions {
  gateway = '';
  /** Cap for a single request. Bun's fetch otherwise cuts every request at an implicit 300s. */
  requestTimeoutMs = 60_000;
  /** Overall wait for a preview job — share_file is an interactive tool call. An ingest waits longer, sized to the file. */
  jobWaitMs = 5 * 60_000;
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

  public async api(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = this.o.requestTimeoutMs): Promise<Record<string, any>> {
    const url = `${this.o.gateway.replace(/\/+$/, '')}${route}`;
    const init = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      timeout: false, signal: AbortSignal.timeout(timeoutMs), // explicit cap replaces Bun's implicit 300s
    };
    const res = await this.o.fetch(url, init as RequestInit);
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || json.ok === false) throw new Error(`offload gateway ${method} ${route} failed: ${res.status} ${json.error ?? JSON.stringify(json)}`);
    return json;
  }

  /** Poll a job to `done` and return its result. A job that outlives `waitMs` is cancelled so it frees the pod. */
  public async waitJob(jobId: string, waitMs = this.o.jobWaitMs): Promise<Record<string, any>> {
    for (const end = Date.now() + waitMs; Date.now() < end;) {
      const j = await this.api('GET', `/media/job?jobId=${encodeURIComponent(jobId)}`);
      if (j.status === 'done') return (j.result ?? {}) as Record<string, any>;
      if (j.status === 'failed' || j.status === 'cancelled') throw new Error(`offload job ${jobId} ${j.status}: ${j.error ?? 'no error given'}`);
      await Bun.sleep(this.o.pollMs);
    }
    await this.api('POST', '/media/cancel', { jobId }).catch(e => console.error(`[offload] cancel of timed-out job ${jobId} failed: ${(e as Error).message}`));
    throw new Error(`offload job ${jobId} did not finish within ${Math.round(waitMs / 1000)}s and was cancelled; no link was made. Send the file as an attachment instead, or retry later.`);
  }

  /** Have the gateway pull an agent `/uploads/...` path of `bytes`; returns the gateway-side file. The wait scales with
   *  the size (60s + 1s/MB) — the pull crosses the network, a flat cap cut large files off. */
  public async ingest(source: string, bytes = 0): Promise<string> {
    const waitMs = Math.max(this.o.requestTimeoutMs, 60_000 + Math.ceil(bytes / (1024 * 1024)) * 1000);
    let r = await this.api('POST', '/media/ingest', { source }, waitMs);
    if (r.async) r = await this.waitJob(String(r.jobId), Math.max(this.o.jobWaitMs, waitMs));
    if (!r.file) throw new Error(`offload ingest of ${source} returned no file: ${JSON.stringify(r)}`);
    return String(r.file);
  }

  /** The gateway's advertised link origin, or undefined when it does not say (or cannot be asked). */
  public async publicBase(): Promise<string | undefined> {
    try {
      const res = await this.o.fetch(`${this.o.gateway.replace(/\/+$/, '')}/media/health`, { signal: AbortSignal.timeout(this.o.requestTimeoutMs) });
      const base = ((await res.json()) as Record<string, unknown>).publicBase; // health may be ok:false (degraded) and still say this
      return typeof base === 'string' && base ? base : undefined;
    } catch (e) {
      console.warn(`[offload] could not read publicBase from ${this.o.gateway}/media/health: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Link for a gateway-side file: a transcoded preview for video, the original bytes otherwise (publish_url pins the
   *  file 7 days — inherent to that route and within the pod's normal retention, so harmless for a human share). */
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
  public async share(src: string, dataDir: string, name: string, bytes = 0): Promise<string> {
    // Refuse before moving any bytes when the gateway says its links are private.
    const base = await this.publicBase();
    if (base && !isPublicUrl(base)) throw new OffloadPrivateLinkError(base);
    const pod = await podCopy(src);
    if (pod) {
      try {
        const url = await this.link(pod, mediaKind(name));
        if (!isPublicUrl(url)) throw new OffloadPrivateLinkError(url);
        return url;
      } catch (e) {
        if (e instanceof OffloadPrivateLinkError) throw e;
        console.warn(`[offload] linking the pod copy ${pod} failed, re-uploading instead: ${(e as Error).message}`);
      }
    }
    const id = `offload-${randomUUID()}`;
    const dir = path.join(dataDir, 'uploads', id);
    mkdirSync(dir, { recursive: true });
    try {
      const staged = path.join(dir, name);
      try { linkSync(src, staged); } catch { copyFileSync(src, staged); }
      const file = await this.ingest(`/uploads/${id}/${encodeURIComponent(name)}`, bytes);
      const url = await this.link(file, mediaKind(name));
      if (!isPublicUrl(url)) throw new OffloadPrivateLinkError(url);
      return url;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The gateway-side path recorded in `<src>.pod.json`, when that sidecar exists and its sha256 still matches `src`. */
export async function podCopy(src: string): Promise<string | undefined> {
  const sidecar = `${src}.pod.json`;
  if (!existsSync(sidecar)) return undefined;
  try {
    const { podFile, sha256 } = JSON.parse(readFileSync(sidecar, 'utf8')) as { podFile?: string; sha256?: string };
    if (!podFile || !sha256) return undefined;
    const hasher = new Bun.CryptoHasher('sha256');
    for await (const chunk of createReadStream(src)) hasher.update(chunk as Uint8Array);
    return hasher.digest('hex') === sha256 ? podFile : undefined; // a file edited since the pull is not the pod copy
  } catch (e) {
    console.warn(`[offload] ignoring unreadable ${sidecar}: ${(e as Error).message}`);
    return undefined;
  }
}

export class OffloadPrivateLinkError extends Error {
  public constructor(public readonly link: string) { super(OFFLOAD_PRIVATE_LINK_ERROR); }
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
    `- To share a file with people, use share_file. Media and files over ${cfg.maxLocalFileMB}MB are linked from the pod when it has a public link origin; small non-media files get a link from this box. If share_file refuses — then send the file as a Slack/email attachment or ask an operator. Never hand people a gateway/pod link yourself (e.g. from its preview tool) unless it is a public https URL — tailnet/private links do not open for them.`,
    '</offload>',
  ].join('\n');
}

// ── Heavy-command guard ─────────────────────────────────────────────────────────────────────────────

/** Split a shell command into simple-command word lists on unquoted `; & | \n` (quote-aware, not a full shell parser;
 *  `bash -c "…"` / `$(…)` are not unpacked — this is a guardrail against the obvious, not a sandbox). Redirections
 *  (`> f`, `2>&1`, `&>/dev/null`) are dropped, and heredoc bodies are skipped — they are data, not commands. */
export function shellSegments(cmd: string): string[][] {
  const segs: string[][] = [];
  const heredocs: string[] = [];
  let words: string[] = [], word = '', quote: string | null = null, inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i]; else word += c; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') { // heredoc: remember the delimiter, skip the body at the next newline
      const m = cmd.slice(i + 2).match(/^-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (m) { endWord(); heredocs.push(m[2]!); i += 1 + m[0].length; continue; }
    }
    if (c === '\n' && heredocs.length) {
      endSeg();
      for (const delim of heredocs.splice(0)) {
        const end = cmd.slice(i + 1).search(new RegExp(`^[ \\t]*${delim}[ \\t]*$`, 'm'));
        if (end < 0) { i = cmd.length; break; }
        i += 1 + end + cmd.slice(i + 1 + end).indexOf(delim) + delim.length;
      }
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && cmd[i + 1] === '>')) { // redirection: drop the fd, the operator and its target
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
      while (/[<>&]/.test(cmd[i + 1] ?? '')) i++;
      if (/\d/.test(cmd[i + 1] ?? '') && cmd[i] === '&') { while (/\d/.test(cmd[i + 1] ?? '')) i++; continue; } // >&1
      while (cmd[i + 1] === ' ' || cmd[i + 1] === '\t') i++;
      let tq: string | null = null;
      while (i + 1 < cmd.length) {
        const t = cmd[i + 1]!;
        if (tq) { if (t === tq) tq = null; } else if (t === '"' || t === "'") tq = t; else if (/[\s;&|()<>]/.test(t)) break;
        i++;
      }
      continue;
    }
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
const AUDIO_OUT = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;

/** ffmpeg argv (no binary) that encodes/transcodes a real output — vs analysis, stream copy, frame grabs, stdout. */
function heavyFfmpeg(args: string[]): boolean {
  if (args.length === 0 || args.some(a => a === '-h' || a === '-version' || a.startsWith('-help') || a === '-encoders' || a === '-codecs')) return false;
  const val = (...flags: string[]) => { const i = args.findIndex(a => flags.includes(a)); return i >= 0 ? args[i + 1] : undefined; };
  if (val('-f') === 'null') return false;
  if (['-c', '-codec', '-c:v', '-vcodec'].some(f => val(f) === 'copy') && !args.includes('-vf') && !args.includes('-filter_complex')) return false;
  const frames = Number(val('-frames:v', '-vframes'));
  if (Number.isFinite(frames) && frames <= 2) return false;
  const out = args[args.length - 1]!;
  // Audio-only extraction (`-vn`, or an audio-only output container) never touches a video encoder.
  if (args.includes('-vn') || AUDIO_OUT.test(out)) return false;
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
      if (/^(@remotion\/cli|remotion)(@.*)?$/.test(rest[0] ?? '') && !rest.slice(1).some(a => /^(--help|-h|--version|-v|help|versions)$/.test(a))) return 'a remotion command';
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
