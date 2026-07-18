#!/usr/bin/env bun
// Ingress router: tiny host-header TCP router fronting shraga instances.
// The deployment's ingress (CF Tunnel or Caddy) always points here; this process
// routes by Host header to local ports. Previews and blue-green flips are just edits
// to the routing file — this process never restarts during a flip (that's why it runs
// as its own process, NOT inside the server: `flip-restart` restarts the server while
// the router holds traffic).
//
//   bun run src/server/ingress-router.ts          # INGRESS_PORT (default 3100)
//   shraga ingress                                # same, via the CLI
//
// Routing file (dataPath('ingress-router.json'), hot-reloaded on change):
//   { "default": 3032, "routes": { "pr-13.preview.agent.example.com": 3850 } }
//
// Works at the TCP level: reads bytes until the first request's headers end, parses Host,
// connects upstream, replays the buffered bytes, then splices both directions blindly.
// WebSocket upgrades and keep-alive flow through untouched (same upstream per connection).

import net from 'node:net';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dataPath } from './paths.ts';

const PORT = Number(process.env.INGRESS_PORT) || 3100;
const CONFIG = dataPath('ingress-router.json');
const HEADER_LIMIT = 16 * 1024;

interface Routing { default: number; routes: Record<string, number>; }
let routing: Routing = { default: 3032, routes: {} };

function loadRouting() {
  try {
    routing = { routes: {}, ...JSON.parse(readFileSync(CONFIG, 'utf-8')) };
    console.log(`[ingress] routing: default→:${routing.default}, ${Object.keys(routing.routes).length} route(s)`);
  } catch (err) {
    console.error(`[ingress] bad routing file, keeping previous:`, (err as Error).message);
  }
}
if (!existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify(routing, null, 2));
loadRouting();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
watch(CONFIG, () => { // debounce — editors fire multiple events per save
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadRouting, 100);
});

function upstreamFor(host: string): number {
  const bare = host.toLowerCase().split(':')[0];
  return routing.routes[bare] ?? routing.default;
}

const server = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  client.once('error', () => client.destroy());

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buf.length > HEADER_LIMIT) client.destroy();
      return;
    }
    client.off('data', onData);
    client.pause();

    const head = buf.subarray(0, headerEnd).toString('latin1');
    const host = /\r\nhost:\s*([^\r\n]+)/i.exec('\r\n' + head)?.[1]?.trim() ?? '';
    const port = upstreamFor(host);

    const upstream = net.connect(port, '127.0.0.1', () => {
      client.setTimeout(0); // routed — long-lived (WS) connections idle freely
      upstream.write(buf);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    const drop = () => { client.destroy(); upstream.destroy(); };
    upstream.on('error', (err) => {
      console.warn(`[ingress] upstream :${port} (${host}):`, err.message);
      if (!client.writableEnded) client.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      upstream.destroy();
    });
    client.on('error', drop);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  };
  client.on('data', onData);
  client.setTimeout(15_000, () => { if (!client.bytesWritten) client.destroy(); });
});

server.listen(PORT, () => console.log(`[ingress] listening on :${PORT}, routing file: ${CONFIG}`));
