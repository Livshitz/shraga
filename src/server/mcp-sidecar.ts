import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { getHttpSidecarSpecs, type HttpSidecarSpec } from './shraga-config.ts';
import { APP_ROOT } from './paths.ts';

const sidecars = new Map<string, { proc: ChildProcess; spec: HttpSidecarSpec }>();

async function isPortAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url.replace('/mcp', '/health'), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let shuttingDown = false;

function startOne(spec: HttpSidecarSpec, restarts = 0) {
  const vendorDir = path.join(APP_ROOT, 'vendor', spec.dir);
  const entrypoint = path.join(vendorDir, 'src/mcp/cli.ts');
  const args = ['run', entrypoint, '--port', String(spec.port)];
  const startedAt = Date.now();

  const proc = spawn('bun', args, {
    cwd: vendorDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line) console.log(`[sidecar:${spec.name}] ${line}`);
    }
  });
  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line) console.log(`[sidecar:${spec.name}] ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[sidecar:${spec.name}] exited code=${code} signal=${signal}`);
    sidecars.delete(spec.name);
    if (shuttingDown) return;
    // Auto-restart on crash (KeepAlive-style). Exponential backoff, capped; reset after a stable run.
    const next = Date.now() - startedAt > 60_000 ? 0 : restarts + 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(next, 5));
    console.log(`[sidecar:${spec.name}] restarting in ${delay}ms (#${next})`);
    setTimeout(() => {
      if (!shuttingDown && !sidecars.has(spec.name)) startOne(spec, next);
    }, delay);
  });

  sidecars.set(spec.name, { proc, spec });
  console.log(`[sidecar] started ${spec.name} pid=${proc.pid} on port ${spec.port}`);
}

export async function startSidecars() {
  const specs = getHttpSidecarSpecs();
  for (const spec of specs) {
    if (sidecars.has(spec.name)) continue;
    if (await isPortAlive(spec.url)) {
      console.log(`[sidecar] ${spec.name} already running on port ${spec.port}`);
      continue;
    }
    try {
      startOne(spec);
    } catch (e) {
      console.error(`[sidecar] failed to start ${spec.name}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

export function stopSidecars() {
  shuttingDown = true;
  for (const [name, { proc }] of sidecars) {
    console.log(`[sidecar] stopping ${name} pid=${proc.pid}`);
    try { proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const [, { proc }] of sidecars) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    sidecars.clear();
  }, 3000);
}
