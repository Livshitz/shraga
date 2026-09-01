#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process';

const args = process.argv.slice(2);

await import('./server/env-resolve.ts');

function flag(name: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` || (short && args[i] === `-${short}`)) {
      return args[i + 1];
    }
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
shraga — multi-user Claude Code web UI

Usage:
  shraga [options]

Options:
  -p, --port <port>       Server port (default: 3032, or PORT env)
  -d, --data-dir <path>   Data directory (default: ./data, or DATA_DIR env)
  -h, --help              Show this help

Subcommands:
  ingress                 Run the host-header TCP router (INGRESS_PORT, default 3100)
                          for previews + blue-green flips. Own process, survives restarts.
  user add <email> <pw>   Seed a local username/password user
  para post [text]        Push a message into a linked para.li conversation.
                          Text from [text], --file <path>, or stdin (preferred for
                          multi-line reports). --conn <id> picks a link when several exist.

Environment:
  CLOUDFLARE_TUNNEL_TOKEN   If set, starts a Cloudflare Tunnel alongside the server.
                            Get the token from Cloudflare Zero Trust > Tunnels > Configure.
  ANTHROPIC_API_KEY         Claude API key (or use \`claude auth login\` for subscription auth)
  VITE_FIREBASE_CONFIG_PROD Firebase config JSON for auth (prod project)
`.trim());
  process.exit(0);
}

const port = flag('port', 'p');
const dataDir = flag('data-dir', 'd');

if (port) process.env.PORT = port;
if (dataDir) process.env.DATA_DIR = dataDir;

// `shraga user add <email> <password>` — seed a local (username/password) user. No server boot.
if (args[0] === 'user' && args[1] === 'add') {
  const email = args[2];
  const password = args[3] || process.env.SHRAGA_PASSWORD;
  if (!email || !password) {
    console.error('usage: shraga user add <email> <password>   (or SHRAGA_PASSWORD env)');
    process.exit(1);
  }
  const { addLocalUser } = await import('./server/auth.ts');
  addLocalUser(email, password);
  console.log(`✅ added local user ${email}`);
  process.exit(0);
}

// `shraga para post [text]` — the PROACTIVE half of the para.li agent lane.
//
// The reactive half (para asks, shraga answers) is driven by para.li calling `/api/para/turn`, and
// the only other outbound path is the deploy-notice bus subscriber in `para/feature.ts` — which is
// gated on `kind === 'deploy'`. So a SCHEDULED run (a daily digest) had no way to reach the lane at
// all: it composes text on its own clock with no inbound turn to answer and no deploy event to ride.
// This is that door, and it is a CLI rather than a route because the caller is the agent itself,
// running Bash on this very box: a local process reading the same `para-links.json` the feature
// writes needs no listener, no API key, and no second copy of the callback secret.
//
// Text comes from stdin by default. A digest is multi-line markdown with backticks and emoji, and
// making a model shell-quote that into argv is a defect generator; `... | shraga para post` is not.
if (args[0] === 'para' && args[1] === 'post') {
  const { loadLinks } = await import('./server/para/feature.ts');
  const { postProactive } = await import('./server/para/streamer.ts');

  const links = loadLinks();
  const wanted = flag('conn');
  const ids = Object.keys(links);
  // Refuse to guess. Picking "the first" would silently deliver a private report to whichever
  // connection happened to sort first the day a second one is added.
  const connId = wanted ?? (ids.length === 1 ? ids[0] : undefined);
  if (!connId || !links[connId]) {
    console.error(ids.length
      ? `usage: shraga para post --conn <connId>   (linked: ${ids.join(', ')})`
      : 'no para link yet — send one message from para.li to this agent first, then retry.');
    process.exit(1);
  }
  const link = links[connId];

  const file = flag('file');
  let text: string;
  if (file) {
    text = (await import('node:fs')).readFileSync(file, 'utf-8');
  } else {
    // A bare positional (not a flag, and not a flag's VALUE) is accepted for one-liners.
    const flagVals = new Set<string>();
    for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flagVals.add(args[i + 1]);
    const positional = args.slice(2).find((a) => !a.startsWith('--') && !flagVals.has(a));
    text = positional ?? await new Response(Bun.stdin.stream()).text();
  }
  if (!text.trim()) {
    console.error('nothing to post: text was empty (pipe it on stdin, pass --file, or give it as an argument)');
    process.exit(1);
  }

  const ok = await postProactive({ url: link.url, secret: link.secret, connId }, link.convId, text);
  // Exit code is the point: `postProactive` swallows transport failures into `false`, so a caller
  // that only looked at stdout would read a silent drop as a successful delivery.
  if (!ok) { console.error(`\u2716 para post FAILED \u2192 ${link.convId}`); process.exit(1); }
  console.log(`\u2705 posted to ${link.convId}`);
  process.exit(0);
}

// `shraga ingress` — host-header TCP router for previews + blue-green flips.
// Runs as its OWN process (INGRESS_PORT), deliberately separate from the server so it
// survives server restarts during a flip. Reads dataPath('ingress-router.json').
if (args[0] === 'ingress') {
  await import('./server/ingress-router.ts');
  // ingress-router keeps the process alive via its listening socket; do not fall through.
} else {

let tunnel: ChildProcess | null = null;

const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
if (tunnelToken) {
  console.log('[tunnel] Starting Cloudflare Tunnel...');
  tunnel = spawn('cloudflared', ['tunnel', 'run', '--token', tunnelToken], {
    stdio: 'inherit',
  });
  tunnel.on('error', (err) => {
    console.error(`[tunnel] Failed to start cloudflared: ${err.message}`);
    console.error('[tunnel] Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  });
  tunnel.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[tunnel] cloudflared exited with code ${code}`);
    }
  });
}

function cleanup() {
  if (tunnel && !tunnel.killed) {
    console.log('[tunnel] Stopping Cloudflare Tunnel...');
    tunnel.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Dogfood the public library surface — the CLI's server-run path IS createShraga(...).start().
const { createShraga, fromEnv } = await import('./index.ts');
await createShraga(fromEnv()).start();

} // end non-ingress server path
