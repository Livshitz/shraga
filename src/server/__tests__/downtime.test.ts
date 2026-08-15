import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Schedule } from '../scheduler/types.ts';

// Drives the REAL downtime module against the REAL scheduler storage, so the assertions are about
// what lands on disk and what the report says — not about agent output or a live Slack workspace.
// The Slack read is injected (BackfillOptions.history), which is why this suite needs no mock.module
// (process-global and permanent in bun) to stay hermetic for sibling files.

let downtime: typeof import('../downtime.ts');
let schedStorage: typeof import('../scheduler/storage.ts');
let DATA_DIR: string;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ['HEARTBEAT_INTERVAL_MS', 'DOWNTIME_THRESHOLD_MS']) savedEnv[k] = process.env[k];
  ({ DATA_DIR } = await import('../paths.ts'));
  downtime = await import('../downtime.ts');
  schedStorage = await import('../scheduler/storage.ts');
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  wipe();
});

const statePath = (f: string) => path.join(DATA_DIR, 'state', f);
function wipe() {
  for (const f of ['heartbeat.json', 'downtime.json', 'slack-cursors.json']) rmSync(statePath(f), { force: true });
  rmSync(path.join(DATA_DIR, 'schedules.json'), { force: true });
}
beforeEach(wipe);

const MIN = 60_000;

function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'dt-1',
    name: 'morning report',
    enabled: true,
    trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
    task: { kind: 'prompt', prompt: 'report' },
    scope: 'system',
    createdBy: { uid: 'u', email: 'u@x' },
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    ...over,
  };
}

describe('heartbeat + gap detection', () => {
  test('a clean restart produces NO downtime entry', () => {
    // Heartbeat written a heartbeat-interval ago — the worst case for a clean restart.
    downtime.writeHeartbeat(Date.now() - downtime.HEARTBEAT_INTERVAL_MS);
    const entry = downtime.recordBootGap();
    expect(entry).toBeNull();
    expect(downtime.listDowntime()).toEqual([]);
    expect(existsSync(statePath('downtime.json'))).toBe(false);
  });

  test('a gap just under the threshold is still a clean restart', () => {
    downtime.writeHeartbeat(Date.now() - (downtime.DOWNTIME_THRESHOLD_MS - 5_000));
    expect(downtime.recordBootGap()).toBeNull();
    expect(downtime.listDowntime()).toEqual([]);
  });

  test('a real outage is recorded as { from: lastHeartbeat, to: bootTime }', () => {
    const last = Date.now() - 5 * 60 * MIN;
    downtime.writeHeartbeat(last);
    const boot = Date.now();
    const entry = downtime.recordBootGap(boot);
    expect(entry).toEqual({ from: last, to: boot, ms: boot - last, cause: 'boot' });
    expect(downtime.listDowntime()).toEqual([entry!]);
  });

  test('the first-ever boot (no heartbeat) records nothing', () => {
    expect(downtime.readHeartbeat()).toBeNull();
    expect(downtime.recordBootGap()).toBeNull();
    expect(downtime.listDowntime()).toEqual([]);
    // …but it does establish the baseline, so the NEXT boot can measure.
    expect(downtime.readHeartbeat()).not.toBeNull();
  });

  test('recordBootGap always refreshes the heartbeat, gap or not', () => {
    const boot = Date.now();
    downtime.writeHeartbeat(boot - 4 * 60 * MIN);
    downtime.recordBootGap(boot);
    expect(downtime.readHeartbeat()).toBe(boot);
  });

  test('startHeartbeat stamps immediately and stops cleanly', async () => {
    const stop = downtime.startHeartbeat(20);
    const first = downtime.readHeartbeat();
    expect(first).not.toBeNull(); // stamped synchronously, not on the first tick

    // Poll rather than sleep a fixed amount: a loaded CI box can miss a 20ms deadline, and a
    // timing-flaky test is worse than no test.
    const deadline = Date.now() + 2_000;
    while (downtime.readHeartbeat()! <= first! && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    const later = downtime.readHeartbeat()!;
    expect(later).toBeGreaterThan(first!);

    stop();
    // After stop() the value must stop advancing — several intervals' worth of quiet.
    const afterStop = downtime.readHeartbeat();
    await new Promise(r => setTimeout(r, 150));
    expect(downtime.readHeartbeat()).toBe(afterStop);
  });
});

// The failure a boot-time check cannot see: the host slept, the process was FROZEN (never
// restarted), so the only surviving signal is a heartbeat tick that comes back late.
describe('suspend detection (late heartbeat tick)', () => {
  test('an on-time tick records nothing', () => {
    const now = Date.now();
    downtime.writeHeartbeat(now - downtime.HEARTBEAT_INTERVAL_MS);
    expect(downtime.recordTickGap(now)).toBeNull();
    expect(downtime.listDowntime()).toEqual([]);
    expect(downtime.readHeartbeat()).toBe(now); // …but liveness still advanced
  });

  test('scheduling jitter just under the threshold is not an outage', () => {
    const now = Date.now();
    downtime.writeHeartbeat(now - (downtime.DOWNTIME_THRESHOLD_MS - 1_000));
    expect(downtime.recordTickGap(now)).toBeNull();
    expect(downtime.listDowntime()).toEqual([]);
  });

  test('a tick late past the threshold records ONE suspend entry', () => {
    const now = Date.now();
    const last = now - (downtime.DOWNTIME_THRESHOLD_MS + 60_000);
    downtime.writeHeartbeat(last);
    const entry = downtime.recordTickGap(now);
    expect(entry).toEqual({ from: last, to: now, ms: now - last, cause: 'suspend' });
    expect(downtime.listDowntime()).toEqual([entry!]);
  });

  test('the real 2h33m clamshell suspend: one entry, not one per missed interval', () => {
    // 19:02 → 21:35, the incident that was invisible: pid alive the whole time, no restart.
    const slept = Date.now() - 153 * MIN;
    downtime.writeHeartbeat(slept);
    const wake = Date.now();
    const entry = downtime.recordTickGap(wake)!;
    expect(entry.cause).toBe('suspend');
    expect(entry.ms).toBe(wake - slept);

    // Every tick after the wake is on time again — the gap must not re-record once per interval.
    for (let i = 1; i <= 5; i++) downtime.recordTickGap(wake + i * downtime.HEARTBEAT_INTERVAL_MS);
    expect(downtime.listDowntime().length).toBe(1);
  });

  test('boot and suspend never double-record the same outage', () => {
    const last = Date.now() - 120 * MIN;
    downtime.writeHeartbeat(last);
    const wake = Date.now();
    // The tick notices it first…
    expect(downtime.recordTickGap(wake)!.cause).toBe('suspend');
    // …and a restart right afterwards (e.g. the user bounces the service on waking) sees a
    // heartbeat that is already current, so it adds nothing.
    expect(downtime.recordBootGap(wake + 1_000)).toBeNull();
    expect(downtime.listDowntime().length).toBe(1);

    // And the other order: a boot gap advances the stamp, so the first tick after it is on time.
    downtime.writeHeartbeat(Date.now() - 200 * MIN);
    const boot = Date.now();
    expect(downtime.recordBootGap(boot)!.cause).toBe('boot');
    expect(downtime.recordTickGap(boot + downtime.HEARTBEAT_INTERVAL_MS)).toBeNull();
    expect(downtime.listDowntime().length).toBe(2);
  });

  test('the running heartbeat timer itself notices a freeze', async () => {
    const stop = downtime.startHeartbeat(20);
    try {
      // Simulate the freeze: rewind the on-disk stamp past the threshold, as a slept host would.
      const frozenAt = Date.now() - (downtime.DOWNTIME_THRESHOLD_MS + 60_000);
      downtime.writeHeartbeat(frozenAt);
      const deadline = Date.now() + 2_000;
      while (!downtime.listDowntime().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      const entries = downtime.listDowntime();
      expect(entries.length).toBe(1);
      expect(entries[0]).toMatchObject({ from: frozenAt, cause: 'suspend' });
      // Subsequent (on-time) ticks keep it at exactly one.
      await new Promise(r => setTimeout(r, 200));
      expect(downtime.listDowntime().length).toBe(1);
    } finally {
      stop();
    }
  });

  test('recording a suspend fires NOTHING — no run, no schedule mutation', () => {
    schedStorage.saveSchedules([makeSchedule({ lastRun: undefined })]);
    const before = readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8');

    downtime.writeHeartbeat(Date.now() - 180 * MIN);
    expect(downtime.recordTickGap()!.cause).toBe('suspend');

    expect(readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8')).toBe(before);
    const s = schedStorage.loadSchedules()[0];
    expect(s.lastRun).toBeUndefined();
    expect(s.runCount).toBe(0);
  });

  test('the report says missedSchedules is INCOMPLETE after a suspend — not that it is empty', async () => {
    // The late timer fire DOES write missedRun for windows it refuses, at a ts inside the gap —
    // which missedSchedules() then joins. A note claiming such windows are "NOT listed" is false.
    const wake = Date.now();
    const from = wake - 153 * MIN;
    downtime.writeHeartbeat(from);
    downtime.recordTickGap(wake);
    schedStorage.saveSchedules([makeSchedule({ missedRun: { at: wake - 100 * MIN, reason: 'stale', noticedAt: wake } })]);

    const report = await downtime.buildReport({ slack: false });
    expect(report.lastDowntime?.cause).toBe('suspend');
    expect(report.missedSchedules.map(m => [m.id, !!m.downtime])).toEqual([['dt-1', true]]);
    expect(report.note).toContain('SUSPEND');
    expect(report.note).toContain('INCOMPLETE');
    expect(report.note).not.toContain('NOT listed in missedSchedules');
  });

  test('a later restart does NOT erase the suspend warning', async () => {
    // Lid closed overnight; the next morning the service is bounced (deploy, reboot) more than the
    // downtime threshold after the wake — that appends a `boot` entry AFTER the suspend one.
    const wake = Date.now() - 60 * MIN;
    downtime.writeHeartbeat(wake - 153 * MIN);
    downtime.recordTickGap(wake);
    downtime.writeHeartbeat(wake + 5 * MIN);
    const boot = wake + 5 * MIN + downtime.DOWNTIME_THRESHOLD_MS + MIN;
    expect(downtime.recordBootGap(boot)!.cause).toBe('boot');

    const report = await downtime.buildReport({ slack: false });
    expect(report.downtime.map(e => e.cause)).toEqual(['suspend', 'boot']);
    expect(report.lastDowntime?.cause).toBe('boot'); // the newest entry is NOT the suspend…
    expect(report.note).toContain('SUSPEND');       // …but the unscanned gap is still flagged
  });

  test('a suspend older than the note window stops being flagged', async () => {
    const wake = Date.now() - (downtime.SUSPEND_NOTE_MAX_AGE_MS + 60 * MIN);
    downtime.writeHeartbeat(wake - 153 * MIN);
    downtime.recordTickGap(wake);
    const report = await downtime.buildReport({ slack: false });
    expect(report.note).not.toContain('SUSPEND');
  });

  test('a suspend gap does NOT snapshot the live Slack cursors', async () => {
    // The snapshot only holds its invariant at boot (taken before the Slack socket mounts). On the
    // suspend path it runs up to a heartbeat interval after the wake — by then the reconnected
    // socket may already have delivered the backlog and pushed the cursor past the whole outage.
    downtime.noteSlackSeen('C1', '100.000000');       // last seen before the lid closed
    const wake = Date.now();
    downtime.writeHeartbeat(wake - 153 * MIN);
    downtime.noteSlackSeen('C1', '999.000000');       // backlog delivered on wake, before the tick
    const entry = downtime.recordTickGap(wake)!;
    expect(entry.slackCursors).toBeUndefined();

    // …so the backfill floors at the outage start, not at the leapfrogged cursor.
    const report = await downtime.buildReport({
      backfill: { history: async () => ({ ok: true, messages: [] }), maxPages: 1 },
    });
    expect(report.slack!.channels).toEqual([{ channel: 'C1', from: String(entry.from / 1000), fetched: 0 }]);
  });
});

describe('bounded history', () => {
  test('keeps only the last DOWNTIME_HISTORY_MAX entries, newest last', () => {
    const n = downtime.DOWNTIME_HISTORY_MAX + 7;
    for (let i = 0; i < n; i++) {
      const boot = 1_000_000 + i * 60 * 60 * 1000;
      downtime.writeHeartbeat(boot - 60 * MIN);
      downtime.recordBootGap(boot);
    }
    const entries = downtime.listDowntime();
    expect(entries.length).toBe(downtime.DOWNTIME_HISTORY_MAX);
    // The OLD ones were dropped, not the new ones.
    expect(entries[entries.length - 1].to).toBe(1_000_000 + (n - 1) * 60 * 60 * 1000);
    expect(entries[0].to).toBe(1_000_000 + (n - downtime.DOWNTIME_HISTORY_MAX) * 60 * 60 * 1000);
    expect(entries.map(e => e.to)).toEqual([...entries.map(e => e.to)].sort((a, b) => a - b));
  });
});

describe('missed-window join (phase 1 owns the decision)', () => {
  test('joins a missedRun to the downtime that covers it, and only proposes', () => {
    const boot = Date.now();
    const from = boot - 6 * 60 * MIN;
    downtime.writeHeartbeat(from);
    downtime.recordBootGap(boot);

    const missedAt = from + 60 * MIN; // 08:00 job that elapsed mid-outage
    schedStorage.saveSchedules([makeSchedule({
      onMissed: 'offer',
      missedRun: { at: missedAt, reason: 'offer', noticedAt: boot },
    })]);

    const missed = downtime.missedSchedules();
    expect(missed.length).toBe(1);
    expect(missed[0].id).toBe('dt-1');
    // Taken verbatim from the schedule — NOT recomputed here.
    expect(missed[0].missedRun).toEqual({ at: missedAt, reason: 'offer', noticedAt: boot });
    expect(missed[0].downtime).toEqual({ from, to: boot, ms: boot - from, cause: 'boot' });
    expect(missed[0].proposal).toContain('POST /api/schedules/dt-1/run');
  });

  test('a missedRun outside every recorded outage still surfaces, with downtime: null', () => {
    schedStorage.saveSchedules([makeSchedule({ missedRun: { at: 5_000, reason: 'stale', noticedAt: 6_000 } })]);
    const missed = downtime.missedSchedules();
    expect(missed.length).toBe(1);
    expect(missed[0].downtime).toBeNull();
  });

  test('a schedule with no missedRun is not reported', () => {
    schedStorage.saveSchedules([makeSchedule()]);
    expect(downtime.missedSchedules()).toEqual([]);
  });
});

describe('slack cursor + backfill dedupe', () => {
  test('the cursor is monotonic — an out-of-order event cannot rewind it', () => {
    downtime.noteSlackSeen('C1', '1700.000200');
    downtime.noteSlackSeen('C1', '1600.000100');
    expect(downtime.listSlackCursors().C1.ts).toBe('1700.000200');
    downtime.noteSlackSeen('C1', '1800.000300');
    expect(downtime.listSlackCursors().C1.ts).toBe('1800.000300');
  });

  test('backfill fetches since the cursor and dedupes by client_msg_id across pages', async () => {
    downtime.noteSlackSeen('C1', '1000.000000');
    const calls: Record<string, unknown>[] = [];
    const pages = [
      {
        ok: true, has_more: true, response_metadata: { next_cursor: 'p2' },
        messages: [
          { ts: '1100.000100', user: 'U1', text: 'hey <@BOT>', client_msg_id: 'a' },
          { ts: '1200.000100', user: 'U2', text: 'ping', client_msg_id: 'b' },
        ],
      },
      {
        ok: true, has_more: false, response_metadata: { next_cursor: '' },
        // 'b' repeats across the page boundary; the bot post carries no client_msg_id.
        messages: [
          { ts: '1200.000100', user: 'U2', text: 'ping', client_msg_id: 'b' },
          { ts: '1300.000100', bot_id: 'B9', text: 'automated' },
        ],
      },
    ];
    const result = await downtime.fetchSlackBackfill({ from: 900_000 }, {
      agentIds: ['BOT'],
      cursors: { C1: '1000.000000' }, // the snapshot taken at boot, not the live cursor
      history: async (_m, body) => { calls.push(body); return pages[calls.length - 1]; },
    });

    expect(result.messages.map(m => m.ts)).toEqual(['1100.000100', '1200.000100', '1300.000100']);
    expect(result.channels).toEqual([{ channel: 'C1', from: '1000', fetched: 3 }]);
    // The snapshot (1000) beats the outage start (900) — we do not re-read what we already saw.
    expect(calls[0].oldest).toBe('1000');
    expect(calls[1].cursor).toBe('p2');
    expect(result.messages.find(m => m.ts === '1100.000100')!.mentionsAgent).toBe(true);
    expect(result.messages.find(m => m.ts === '1300.000100')!.mentionsAgent).toBe(false);
  });

  test('same-second ts values are compared exactly (16 digits, not as doubles)', () => {
    downtime.noteSlackSeen('C1', '1755200000.123456');
    downtime.noteSlackSeen('C1', '1755200000.123457'); // 1 in the 16th digit — Number() rounds these equal
    expect(downtime.listSlackCursors().C1.ts).toBe('1755200000.123457');
  });

  test('recordBootGap freezes the Slack cursors into the entry, before live traffic moves them', () => {
    downtime.noteSlackSeen('C1', '1000.000000');
    const boot = Date.now();
    downtime.writeHeartbeat(boot - 60 * MIN);
    const entry = downtime.recordBootGap(boot);
    expect(entry!.slackCursors).toEqual({ C1: '1000.000000' });
    // A message arriving after recovery moves the LIVE cursor; the snapshot does not budge.
    downtime.noteSlackSeen('C1', '9999.000000');
    expect(downtime.listDowntime()[0].slackCursors).toEqual({ C1: '1000.000000' });
  });

  test('REGRESSION: one live message after recovery must not skip the whole outage backlog', async () => {
    // The headline case: 11h outage (10:00→21:00Z), one normal message at 21:01, then "what did I
    // miss?" minutes later. The live cursor now sits at 21:01 — asking Slack from there returns
    // nothing, and the report would claim a quiet outage.
    const from = Date.UTC(2026, 0, 1, 10, 0, 0);
    const to = Date.UTC(2026, 0, 1, 21, 0, 0);
    downtime.noteSlackSeen('C1', `${Math.floor(Date.UTC(2026, 0, 1, 9, 55, 0) / 1000)}.000000`); // last seen BEFORE the outage
    downtime.writeHeartbeat(from);
    downtime.recordBootGap(to);
    downtime.noteSlackSeen('C1', `${Math.floor(Date.UTC(2026, 0, 1, 21, 1, 0) / 1000)}.000000`); // live traffic after recovery

    const calls: Record<string, unknown>[] = [];
    const report = await downtime.buildReport({
      backfill: {
        history: async (_m, body) => {
          calls.push(body);
          return { ok: true, messages: [{ ts: `${Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000)}.000100`, user: 'U1', text: 'you around?', client_msg_id: 'a' }] };
        },
      },
    });

    expect(Number(calls[0].oldest)).toBe(from / 1000); // 10:00Z, NOT 21:01Z
    expect(report.slack!.channels[0].fetched).toBe(1);
    expect(report.slack!.messages[0].text).toBe('you around?');
  });

  test('a channel with no cursor at all is still read, seeded from SLACK_AGENT_CHANNEL', async () => {
    process.env.SLACK_AGENT_CHANNEL = 'CAGENT';
    try {
      const calls: Record<string, unknown>[] = [];
      const res = await downtime.fetchSlackBackfill({ from: 900_000 }, {
        history: async (_m, body) => { calls.push(body); return { ok: true, messages: [] }; },
      });
      expect(res.skipped).toBeUndefined();
      expect(res.channels.map(c => c.channel)).toEqual(['CAGENT']);
      expect(calls[0].oldest).toBe('900');
    } finally { delete process.env.SLACK_AGENT_CHANNEL; }
  });

  test('hitting the page cap is reported as truncated, in the channel AND in the report note', async () => {
    downtime.writeHeartbeat(Date.now() - 60 * MIN);
    downtime.recordBootGap();
    downtime.noteSlackSeen('C1', '1.000000');
    let page = 0;
    const opts = {
      maxPages: 2,
      history: async () => ({
        ok: true, has_more: true, response_metadata: { next_cursor: `p${++page}` },
        messages: [{ ts: `${1000 + page}.000100`, user: 'U1', text: 'x', client_msg_id: `m${page}` }],
      }),
    };
    const res = await downtime.fetchSlackBackfill({ from: 900_000 }, opts);
    expect(res.channels[0].truncated).toBe(true);
    expect(res.channels[0].fetched).toBe(2); // capped, with more still waiting

    page = 0;
    const report = await downtime.buildReport({ backfill: opts });
    expect(report.note).toContain('INCOMPLETE');
    expect(report.note).toContain('C1');
  });

  test('a complete fetch is NOT flagged truncated', async () => {
    const res = await downtime.fetchSlackBackfill({ from: 900_000 }, {
      maxPages: 2,
      cursors: { C1: '1.000000' },
      history: async () => ({ ok: true, has_more: false, messages: [] }),
    });
    expect(res.channels[0].truncated).toBeUndefined();
  });

  test('the outage start wins when it is later than a stale cursor', async () => {
    downtime.noteSlackSeen('C1', '500.000000');
    const calls: Record<string, unknown>[] = [];
    await downtime.fetchSlackBackfill({ from: 900_000 }, {
      history: async (_m, body) => { calls.push(body); return { ok: true, messages: [] }; },
    });
    expect(calls[0].oldest).toBe('900');
  });

  test('no cursor at all ⇒ nothing fetched, and it says so', async () => {
    let called = false;
    const res = await downtime.fetchSlackBackfill({ from: 0 }, { history: async () => { called = true; return { ok: true }; } });
    expect(called).toBe(false);
    expect(res.messages).toEqual([]);
    expect(res.skipped).toContain('no channels seen');
  });

  test('a Slack error is reported per channel, not thrown', async () => {
    downtime.noteSlackSeen('C1', '1000.000000');
    const res = await downtime.fetchSlackBackfill({ from: 0 }, {
      history: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    expect(res.channels[0].error).toBe('channel_not_found');
    expect(res.messages).toEqual([]);
  });
});

describe('nothing fires without an explicit request', () => {
  test('boot bookkeeping never starts a run', () => {
    const boot = Date.now();
    downtime.writeHeartbeat(boot - 14 * 60 * MIN); // the incident: a 14h-ish outage
    schedStorage.saveSchedules([makeSchedule({
      onMissed: 'offer',
      missedRun: { at: boot - 13 * 60 * MIN, reason: 'offer', noticedAt: boot },
    })]);

    downtime.recordBootGap(boot);
    downtime.startHeartbeat(10_000)();

    // No run lock claimed, no attempt recorded — the ledger is inert.
    expect(schedStorage.readRunningMarker('dt-1')).toBeNull();
    expect(schedStorage.readCompletionMarker('dt-1')).toBeNull();
  });

  test('buildReport reports and proposes — it starts nothing and leaves the schedule untouched', async () => {
    const boot = Date.now();
    const from = boot - 8 * 60 * MIN;
    downtime.writeHeartbeat(from);
    downtime.recordBootGap(boot);
    schedStorage.saveSchedules([makeSchedule({
      onMissed: 'offer',
      missedRun: { at: from + 30 * MIN, reason: 'offer', noticedAt: boot },
    })]);
    const before = readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8');

    downtime.noteSlackSeen('C1', '1000.000000');
    let slackWrites = 0;
    const report = await downtime.buildReport({
      backfill: {
        history: async (method) => {
          // The ONLY Slack call a report may make is a read.
          if (method !== 'conversations.history') slackWrites++;
          return { ok: true, messages: [{ ts: '1100.000100', user: 'U1', text: 'you around?', client_msg_id: 'a' }] };
        },
      },
    });

    expect(report.lastDowntime).toEqual({ from, to: boot, ms: boot - from, cause: 'boot' });
    expect(report.missedSchedules.length).toBe(1);
    expect(report.missedSchedules[0].proposal).toContain('POST /api/schedules/dt-1/run');
    expect(report.slack!.messages.length).toBe(1);
    expect(report.note).toContain('nothing here has been run');

    expect(slackWrites).toBe(0);
    expect(schedStorage.readRunningMarker('dt-1')).toBeNull();
    expect(schedStorage.readCompletionMarker('dt-1')).toBeNull();
    // The missedRun is still there — reading the report does not consume or clear the offer.
    expect(readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8')).toBe(before);
  });

  test('buildReport({ slack: false }) makes no Slack call at all', async () => {
    downtime.noteSlackSeen('C1', '1000.000000');
    downtime.writeHeartbeat(Date.now() - 60 * MIN);
    downtime.recordBootGap();
    const report = await downtime.buildReport({ slack: false });
    expect(report.slack).toBeUndefined();
  });
});
