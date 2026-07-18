#!/usr/bin/env bun
// Generic alert throttle — dedups repeated alerts for the same key within a window.
// Use from any prompt/job/bash task that wants to avoid alert floods (event-trigger
// schedules can instead use the built-in `trigger.throttle`, which suppresses BEFORE
// an agent is spawned — see defaults/skills/scheduler.md).
// Prints exactly one line: `DECISION=alert` or `DECISION=suppress`.
// Usage: bun run data/scripts/notifier-throttle.ts --job "<name>" --error "<error>" [--window-hours 6]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const job = (arg('job') || 'unknown').trim();
const error = (arg('error') || '').trim();
const windowMs = Number(arg('window-hours') || 6) * 3600_000;
const now = Date.now();

// Signature: collapse whitespace, drop digits (timestamps/ids vary run-to-run),
// lowercase, cap length — so "token expired on <date A>" == "<date B>".
const sig = error.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
const key = `${job}::${sig}`;

const STATE = join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'state', 'notifier-throttle.json');
let state: Record<string, number> = {};
try { if (existsSync(STATE)) state = JSON.parse(readFileSync(STATE, 'utf8')); }
catch (e) { console.error('[notifier-throttle] read failed, starting fresh:', (e as Error).message); }

// Self-maintaining prune: drop entries older than the window.
for (const k of Object.keys(state)) if (now - state[k] > windowMs) delete state[k];

const last = state[key];
const suppress = last !== undefined && now - last < windowMs;

if (!suppress) {
  state[key] = now;
  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[notifier-throttle] write failed:', (e as Error).message); }
}

console.log(`DECISION=${suppress ? 'suppress' : 'alert'}`);
process.exit(0);
