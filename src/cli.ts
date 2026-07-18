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
