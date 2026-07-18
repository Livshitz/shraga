import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { DATA_DIR, dataPath } from '../paths.ts';
import type { Schedule, CompletionMarker, RunningMarker } from './types.ts';
import { dataSync } from '../data-sync.ts';

const FILE = dataPath('schedules.json');
const COMPLETIONS_DIR = dataPath('scheduler/completions');
const RUNNING_DIR = dataPath('scheduler/running');
const THROTTLE_FILE = dataPath('state/trigger-throttle.json');

/** Per-trigger event throttle ledger: dedup-key → last-fired epoch ms. */
export function loadThrottleState(): Record<string, number> {
  if (!existsSync(THROTTLE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(THROTTLE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('[scheduler] failed to parse trigger-throttle.json, starting fresh:', err);
    return {};
  }
}

export function saveThrottleState(state: Record<string, number>): void {
  mkdirSync(dataPath('state'), { recursive: true });
  const tmp = `${THROTTLE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, THROTTLE_FILE);
}

export function loadSchedules(): Schedule[] {
  if (!existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[scheduler] failed to parse schedules.json:', err);
    return [];
  }
}

export function saveSchedules(schedules: Schedule[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Guard: if existing file has significantly more schedules, back up before overwriting
  if (existsSync(FILE)) {
    try {
      const existing = JSON.parse(readFileSync(FILE, 'utf-8'));
      if (Array.isArray(existing) && existing.length > schedules.length + 2) {
        const bak = `${FILE}.bak`;
        writeFileSync(bak, JSON.stringify(existing, null, 2));
        console.warn(`[scheduler] ⚠️ saving ${schedules.length} schedules over ${existing.length} on disk — backup at schedules.json.bak`);
      }
    } catch { /* parse error — overwrite is fine */ }
  }
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  renameSync(tmp, FILE);
  dataSync.trackWrite('schedules.json');
}

export function readCompletionMarker(scheduleId: string): CompletionMarker | null {
  const file = `${COMPLETIONS_DIR}/${scheduleId}.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[scheduler] failed to read completion marker for ${scheduleId}:`, err);
    return null;
  }
}

export function writeCompletionMarker(marker: CompletionMarker): void {
  mkdirSync(COMPLETIONS_DIR, { recursive: true });
  const file = `${COMPLETIONS_DIR}/${marker.scheduleId}.json`;
  writeFileSync(file, JSON.stringify(marker, null, 2));
}

export function writeRunningMarker(marker: RunningMarker): void {
  mkdirSync(RUNNING_DIR, { recursive: true });
  writeFileSync(`${RUNNING_DIR}/${marker.scheduleId}.json`, JSON.stringify(marker, null, 2));
}

export function readRunningMarker(scheduleId: string): RunningMarker | null {
  const file = `${RUNNING_DIR}/${scheduleId}.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearRunningMarker(scheduleId: string): void {
  try { unlinkSync(`${RUNNING_DIR}/${scheduleId}.json`); } catch { /* best-effort */ }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
