// Editing data/shraga.config.ts must take effect in a RUNNING process.
//
// Before the fix, `loadShragaConfig` cached the config for the process lifetime (no invalidation,
// no watcher, no TTL), so a one-line config change needed a restart — on circles a ~90s graceful
// drain that cuts in-flight turns. Per-user MCP config (`data/mcps/<uid>.json`) was already re-read
// every call; the asymmetry had no principled reason.
//
// Every case runs in a REAL child process with its own DATA_DIR, asserting through the real
// consumer surface (`getGlobalMcpConfig()` from mcp.ts), because the bug IS process lifetime —
// an in-process test that re-imports the module would not reproduce it.
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

function deployment(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'shraga-hotreload-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  roots.push(root);
  return root;
}

const configFor = (name: string) =>
  `import { defineConfig } from ${JSON.stringify(path.join(SERVER_DIR, 'shraga-config.ts'))};\n` +
  `export default defineConfig({ mcps: { ${name}: { command: 'bun', args: ['run', '${name}'] } } });\n`;

/** Run a script inside a live process whose DATA_DIR is `root`; returns its stdout lines. */
async function run(root: string, body: string): Promise<{ out: string[]; stderr: string }> {
  const script = path.join(root, 'driver.ts');
  writeFileSync(
    script,
    `import { getGlobalMcpConfig } from ${JSON.stringify(path.join(SERVER_DIR, 'mcp.ts'))};\n` +
      `import { loadShragaConfig } from ${JSON.stringify(path.join(SERVER_DIR, 'shraga-config.ts'))};\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `const CONFIG = ${JSON.stringify(path.join(root, 'data', 'shraga.config.ts'))};\n` +
      `const names = () => Object.keys(getGlobalMcpConfig()).sort().join(',') || '(none)';\n` +
      `const say = (label: string, v: string) => console.log('OUT ' + label + '=' + v);\n` +
      body,
  );
  const proc = Bun.spawn(['bun', 'run', script], {
    env: { ...process.env, DATA_DIR: path.join(root, 'data') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { out: stdout.split('\n').filter(l => l.startsWith('OUT ')).map(l => l.slice(4)), stderr };
}

/** mtime has 1s granularity on some filesystems; make an edit unambiguously newer. */
const EDIT = (src: string) => `writeFileSync(CONFIG, ${JSON.stringify(src)});\n` +
  `await Bun.sleep(1100);\n`;

/** A config that `require` CANNOT load (top-level await), forcing loadShragaConfig's async fallback. */
const tlaConfigFor = (name: string) =>
  `import { defineConfig } from ${JSON.stringify(path.join(SERVER_DIR, 'shraga-config.ts'))};\n` +
  `await Promise.resolve();\n` +
  `export default defineConfig({ mcps: { ${name}: { command: 'bun', args: ['run', '${name}'] } } });\n`;

describe('global config hot-reload', () => {
  test('a config edited on disk is picked up without restarting the process', async () => {
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('before'));
    const { out } = await run(root, [
      `await loadShragaConfig();`,
      `say('boot', names());`,
      EDIT(configFor('adlib')),
      `say('afterEdit', names());`,
    ].join('\n'));
    // Same process, no restart, no explicit invalidate call.
    expect(out).toEqual(['boot=before', 'afterEdit=adlib']);
  });

  test('re-reading defeats the runtime module cache (a plain re-import returns the stale module)', async () => {
    // Guards the specific trap: clearing the internal cache is NOT sufficient, because
    // `await import(samePath)` hands back the already-evaluated module object.
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('v1'));
    const { out } = await run(root, [
      `await loadShragaConfig();`,
      EDIT(configFor('v2')),
      `const plain = Object.keys((await import(CONFIG)).default.mcps).join(',');`,
      `say('plainImport', plain);`,
      `say('loader', names());`,
    ].join('\n'));
    // The control: a naive re-import is still stale in the same process...
    expect(out).toContain('plainImport=v1');
    // ...while the loader is fresh. If these were equal the test would prove nothing.
    expect(out).toContain('loader=v2');
  });

  test('a config that throws on import leaves the last-good value in place, and recovers when fixed', async () => {
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('good'));
    const { out, stderr } = await run(root, [
      `await loadShragaConfig();`,
      `say('boot', names());`,
      EDIT(`export default { mcps: { broken: {{{ }\n`),
      `say('afterBroken', names());`,
      `say('afterBrokenTwice', names());`,
      EDIT(configFor('fixed')),
      `say('afterFix', names());`,
    ].join('\n'));
    expect(out).toEqual(['boot=good', 'afterBroken=good', 'afterBrokenTwice=good', 'afterFix=fixed']);
    // Loud, but exactly once per broken version — not once per read.
    expect(stderr.match(/\[config\] failed to load/g)?.length).toBe(1);
    expect(stderr).toContain('KEEPING the last-good config');
  });

  test('an unchanged file is not re-evaluated (the stat gate, not a reload-every-call)', async () => {
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('stable'));
    const { out } = await run(root, [
      `import { getShragaConfigSync } from ${JSON.stringify(path.join(SERVER_DIR, 'shraga-config.ts'))};`,
      `await loadShragaConfig();`,
      `const a = getShragaConfigSync();`,
      `for (let i = 0; i < 50; i++) getShragaConfigSync();`,
      `say('identical', String(getShragaConfigSync() === a));`,
    ].join('\n'));
    expect(out).toEqual(['identical=true']);
  });
  // ── Gaps found in the original hot-reload change, fixed here ──────────────────────────────────

  test('a config file that disappears keeps the last-good global MCPs, and says so once', async () => {
    // The whole point of a global config is the MCP set. A deleted file used to reset the cache to
    // `{}` — every global MCP gone from a running process, with nothing in the log to explain it.
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('good'));
    const { out, stderr } = await run(root, [
      `import { rmSync } from 'node:fs';`,
      `await loadShragaConfig();`,
      `say('boot', names());`,
      `rmSync(CONFIG);`,
      `say('afterDelete', names());`,
      `say('afterDeleteTwice', names());`,
    ].join('\n'));
    expect(out).toEqual(['boot=good', 'afterDelete=good', 'afterDeleteTwice=good']);
    // Loud, but once — not once per read.
    expect(stderr.match(/is GONE from/g)?.length).toBe(1);
    expect(stderr).toContain('global MCPs preserved');
  });

  test('a truncated (0-byte) config is a failed write, not an authored "no MCPs"', async () => {
    // `require` returns {} for an empty file WITHOUT throwing, so this slipped past the
    // broken-config guard and wiped every global MCP silently.
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), configFor('good'));
    const { out, stderr } = await run(root, [
      `await loadShragaConfig();`,
      `say('boot', names());`,
      `writeFileSync(CONFIG, '');`,
      `say('afterTruncate', names());`,
      EDIT(configFor('fixed')),
      `say('afterFix', names());`,
    ].join('\n'));
    expect(out).toEqual(['boot=good', 'afterTruncate=good', 'afterFix=fixed']);
    expect(stderr).toContain('empty (0 bytes)');
    expect(stderr).toContain('KEEPING the last-good config');
  });

  test('the async fallback never overwrites a newer config loaded while it awaited', async () => {
    // Lost update: caller A takes the top-level-await path for version 2; while it is parked on the
    // import, caller B synchronously loads version 3. A used to commit v2 on top of v3 and stamp it
    // as current — so A's own return value was stale even though v3 was already in the cache.
    //
    // Whether that path is reachable AT ALL is runtime-dependent: `require` of an async module
    // throws on Bun 1.3.x (which is what makes the fallback exist) but succeeds on Bun >=1.4. When
    // it succeeds there is no fallback and no race — v2 is then the CORRECT answer, because the
    // config really was read before v3 was written. So the driver reports which runtime it is on
    // and we assert the outcome that runtime owes us, instead of assuming the older one.
    const root = deployment();
    writeFileSync(path.join(root, 'data', 'shraga.config.ts'), tlaConfigFor('v1'));
    const probe = path.join(root, 'tla-probe.ts');
    writeFileSync(probe, 'await Promise.resolve();\nexport default {};\n');
    const { out } = await run(root, [
      `import { createRequire } from 'node:module';`,
      `let tlaThrows = false;`,
      `try { createRequire(import.meta.url)(${JSON.stringify(probe)}); } catch { tlaThrows = true; }`,
      `say('asyncFallbackReachable', String(tlaThrows));`,
      `await loadShragaConfig();`,
      `say('boot', names());`,
      EDIT(tlaConfigFor('v2')),
      // A: on Bun 1.3.x require throws (async module) -> parks on `await import(...v2)`.
      `const pending = loadShragaConfig();`,
      // B: still synchronous, so this lands BEFORE A's import can resolve. A shorter, require-able
      // file: the stamp is mtime+size, so the size change alone makes it a new version.
      `writeFileSync(CONFIG, ${JSON.stringify(configFor('v3'))});`,
      `say('syncCallerSees', names());`,
      `const returned = await pending;`,
      `say('asyncCallerReturned', Object.keys(returned.mcps ?? {}).sort().join(',') || '(none)');`,
    ].join('\n'));

    const reachable = out.includes('asyncFallbackReachable=true');
    expect(out.slice(1, 3)).toEqual(['boot=v1', 'syncCallerSees=v3']);
    // The point of the fix: when the fallback IS taken, the awaiting caller must not be handed the
    // older config that it clobbered v3 with. Without the fix this reads v2.
    expect(out[3]).toBe(reachable ? 'asyncCallerReturned=v3' : 'asyncCallerReturned=v2');
  });
});
