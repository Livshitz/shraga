// SDK resume through the REAL ClaudeCodeEngine, with only the SDK `query` stubbed (snapshot + delegate:
// mock.module is process-global). Each turn records what the CLI would have been given (prompt, resume id)
// so the multi-turn failure modes are checked where they happen: a cancelled turn, a speaker change, a
// non-resume error on a resume turn, and a takeover while the previous CLI process is still alive.
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConvMessage } from '../sessions.ts';

const cfgDir = mkdtempSync(path.join(tmpdir(), 'resume-engine-'));
const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
let active = false;
const calls: { prompt: string; resume?: string }[] = [];
/** `io.first` is the prompt's user message, `io.input` the rest of the streaming input (open while the turn runs). */
let scripts: ((o: any, io: { first: any; input: AsyncIterator<any> }) => AsyncGenerator<any>)[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: any) => {
    if (!active) return (realSdk.query as any)(args);
    const s = scripts.shift();
    if (!s) throw new Error('unexpected extra query() call');
    const call = { prompt: '', resume: args.options.resume as string | undefined };
    calls.push(call);
    // The prompt is streaming input held open for the turn: read only its first (user) message.
    return (async function* () {
      const input = args.prompt[Symbol.asyncIterator]();
      const { value } = await input.next();
      const c = value.message.content;
      call.prompt = typeof c === 'string' ? c : c.findLast((x: any) => x.type === 'text').text;
      yield* s(args.options, { first: value, input });
    })();
  },
}));

const { ClaudeCodeEngine } = await import('../engine/claude-code.ts');
const { upsertSession, getSession } = await import('../sessions.ts');

const savedCfg = process.env.CLAUDE_CONFIG_DIR;
const logs: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
const children: { kill: (s?: string) => boolean; once: (e: string, f: () => void) => void; exitCode: number | null }[] = [];
beforeAll(() => {
  active = true;
  process.env.CLAUDE_CONFIG_DIR = cfgDir; // box-default transcripts live here for the transcript-exists check
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterAll(() => {
  active = false;
  logSpy.mockRestore();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  rmSync(cfgDir, { recursive: true, force: true });
});

const transcript = (id: string) => {
  mkdirSync(path.join(cfgDir, 'projects', 'p'), { recursive: true });
  writeFileSync(path.join(cfgDir, 'projects', 'p', `${id}.jsonl`), '{}\n');
};
// An API-key source keeps the engine from reading (and caching) the real box login's identity for sibling test files.
const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-4-5', apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [] });
const ok = (id: string, text = 'ok') => async function* () {
  yield init(id);
  yield { type: 'stream_event', session_id: id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
  yield { type: 'result', subtype: 'success', session_id: id, num_turns: 1, result: text, usage: { input_tokens: 1 } };
};
const cancelBeforeOutput = (id: string) => async function* (o: any) {
  yield init(id);
  o.abortController.abort();
  throw Object.assign(new Error('aborted'), { name: 'AbortError' });
};
const LIMIT = "You've hit your limit · resets 2pm (UTC)";
const limitResult = (id: string) => async function* () {
  yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, session_id: id, num_turns: 1, result: LIMIT, usage: {} };
};
const noConversation = (id: string) => async function* () {
  yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'x', errors: [`No conversation found with session ID: ${id}`] };
};
const throws = (message: string) => async function* () { throw new Error(message); };

type Speaker = { uid: string; email: string; name: string; role: string };
const ALICE: Speaker = { uid: 'uid-alice', email: 'alice@x.test', name: 'ALICE', role: 'member' };
const BOB: Speaker = { uid: 'uid-bob', email: 'bob@x.test', name: 'BOB', role: 'member' };
const msg = (role: ConvMessage['role'], text: string): ConvMessage => ({ id: crypto.randomUUID(), role, blocks: [{ type: 'text', text }] });

/** One turn the way a channel runs it: append the user message, stream, append the reply if any. */
async function turn(sid: string, conv: ConvMessage[], who: Speaker, text: string, workspace = '<workspace>t1</workspace>') {
  conv.push(msg('user', text));
  const sections = { user: `<current_user>\nname: ${who.name}\nemail: ${who.email}\nrole: ${who.role}\n</current_user>`, workspace };
  const events: any[] = [];
  for await (const ev of new ClaudeCodeEngine().stream({
    prompt: text, conversation: [...conv], contextBlock: Object.values(sections).join('\n'), contextSections: sections,
    sessionId: sid, uid: who.uid, userEmail: who.email, abortController: new AbortController(),
    directives: { resume: true }, config: {} as any,
  })) events.push(ev);
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  if (reply) conv.push(msg('assistant', reply));
  return events;
}
const newSid = () => { const sid = `resume-eng-${crypto.randomUUID()}`; upsertSession(sid, 'hi', { uid: 'u', email: 'e@x.test' }); return sid; };
const pathLog = (sid: string) => logs.filter((l) => l.includes('[claude] Cache:')).at(-1);
const reset = () => { calls.length = 0; scripts = []; logs.length = 0; };

describe('cancelled resume turn (issue 1)', () => {
  test('a turn cancelled before the first token cannot leave identity or other context stale', async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-1')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-1');
    // Same speaker, promoted to owner and the workspace changed; the CLI wrote this prompt, then got cancelled.
    scripts = [cancelBeforeOutput('cc-1')];
    await turn(sid, conv, { ...ALICE, role: 'owner' }, 'delete it', '<workspace>t2</workspace>');
    expect(calls[1].resume).toBe('cc-1');
    expect(calls[1].prompt).toContain('role: owner');
    // Back to turn-1 context: hash-equal to what was stored before the cancel, but NOT what the transcript holds last.
    scripts = [ok('cc-1')];
    await turn(sid, conv, ALICE, 'who am I and what is my role?');
    expect(calls[2].resume).toBe('cc-1');
    expect(calls[2].prompt).toContain('<section name="user">');
    expect(calls[2].prompt).toContain('role: member');
    expect(calls[2].prompt).toContain('<section name="workspace">\n<workspace>t1</workspace>');
  });

  test('the user section rides after the user text on a resume turn even when nothing changed', async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-2')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-2');
    scripts = [ok('cc-2')];
    await turn(sid, conv, ALICE, 'again');
    expect(calls[1].resume).toBe('cc-2');
    expect(calls[1].prompt.startsWith('again\n\n<context_update>')).toBe(true);
    expect(calls[1].prompt).toContain('name: ALICE');
    expect(calls[1].prompt).not.toContain('<section name="workspace">');
  });
});

describe('speaker change (issue 2)', () => {
  test('A → B goes fresh (speaker-change); A → B(cancelled) → A resumes A\'s session with A\'s identity only', async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-a')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-a');
    const stored = getSession(sid)?.claudeResume;
    expect(stored?.speaker).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('alice@x.test');

    scripts = [cancelBeforeOutput('cc-b')];
    await turn(sid, conv, BOB, 'hello from bob');
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].prompt).toContain('<conversation_history>');

    scripts = [ok('cc-a')];
    await turn(sid, conv, ALICE, 'who is the current user?');
    expect(calls[2].resume).toBe('cc-a');
    expect(calls[2].prompt).toContain('name: ALICE');
    expect(calls[2].prompt).not.toContain('name: BOB');
  });

  test('B finishing a fresh turn takes over the mapping; A then falls back again — logged path=fallback:speaker-change', async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-a2')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-a2');
    scripts = [ok('cc-b2')];
    await turn(sid, conv, BOB, 'hello from bob');
    expect(calls[1].resume).toBeUndefined();
    expect(pathLog(sid)).toContain('path=fallback:speaker-change');
    expect(getSession(sid)?.claudeResume?.claudeSessionId).toBe('cc-b2');
    transcript('cc-b2');
    scripts = [ok('cc-a3')];
    await turn(sid, conv, ALICE, 'back');
    expect(calls[2].resume).toBeUndefined();
    expect(pathLog(sid)).toContain('path=fallback:speaker-change');
  });
});

describe('resume-failed only for resume failures (issue 3)', () => {
  async function resumable() {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-r')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-r');
    calls.length = 0;
    return { sid, conv };
  }

  test('a rate-limit error on a resume turn surfaces as a fresh query would — one call, mapping kept', async () => {
    const { sid, conv } = await resumable();
    scripts = [limitResult('cc-r')];
    const events = await turn(sid, conv, ALICE, 'next');
    expect(calls.map((c) => c.resume)).toEqual(['cc-r']);
    expect(events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual([`Claude API error: ${LIMIT}`]);
    expect(getSession(sid)?.claudeResume?.claudeSessionId).toBe('cc-r');
  });

  test('a thrown non-resume error surfaces too — one call, mapping kept', async () => {
    const { sid, conv } = await resumable();
    scripts = [throws('Claude Code process exited with code 1')];
    const events = await turn(sid, conv, ALICE, 'next');
    expect(calls.length).toBe(1);
    expect(events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(['Claude Code process exited with code 1']);
    expect(getSession(sid)?.claudeResume?.claudeSessionId).toBe('cc-r');
  });

  test('"No conversation found" retries fresh in the same turn and remaps', async () => {
    const { sid, conv } = await resumable();
    scripts = [noConversation('cc-r'), ok('cc-new')];
    const events = await turn(sid, conv, ALICE, 'next');
    expect(calls.map((c) => c.resume)).toEqual(['cc-r', undefined]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(pathLog(sid)).toContain('path=fallback:resume-failed');
    expect(getSession(sid)?.claudeResume?.claudeSessionId).toBe('cc-new');
  });
});

describe('takeover while the previous CLI is alive (issue 4)', () => {
  test('a turn whose session still has a live CLI process goes fresh; once it exits, resume is back', async () => {
    reset();
    const savedWait = ClaudeCodeEngine.cliExitWaitMs;
    ClaudeCodeEngine.cliExitWaitMs = 300;
    const sid = newSid(); const conv: ConvMessage[] = [];
    let child: (typeof children)[number] | undefined;
    scripts = [async function* (o: any) {
      child = o.spawnClaudeCodeProcess({ command: 'sleep', args: ['30'], env: process.env });
      children.push(child!);
      yield* ok('cc-t')();
    }];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-t');
    expect(child?.exitCode).toBeNull(); // still running: the stream ended, the process did not

    scripts = [ok('cc-t2')];
    await turn(sid, conv, ALICE, 'steer: actually do Y');
    expect(calls[1].resume).toBeUndefined();
    expect(pathLog(sid)).toContain('path=fallback:concurrent-run');
    transcript('cc-t2');

    await new Promise<void>((r) => { child!.once('exit', () => r()); child!.kill('SIGKILL'); });
    // A CLI that exits within the wait (the normal steer/queued-message case) is awaited, not treated as concurrent.
    scripts = [async function* (o: any) {
      children.push(o.spawnClaudeCodeProcess({ command: 'sleep', args: ['0.1'], env: process.env }));
      yield* ok('cc-t2')();
    }, ok('cc-t2')];
    await turn(sid, conv, ALICE, 'next');
    expect(calls[2].resume).toBe('cc-t2');
    await turn(sid, conv, ALICE, 'right after');
    expect(calls[3].resume).toBe('cc-t2');
    ClaudeCodeEngine.cliExitWaitMs = savedWait;
  }, 15_000);
});

describe('background tasks and resumed sessions', () => {
  const text = (id: string, t: string) => ({ type: 'stream_event', session_id: id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
  const result = (id: string, turns: number, t: string, uuid?: string) =>
    ({ type: 'result', subtype: 'success', session_id: id, num_turns: turns, result: t, usage: {}, ...(uuid ? { user_message_uuids: [uuid], user_message_uuid: uuid } : {}) });

  test('a bg task outstanding at result keeps the input open, and the follow-up turn on its notification ends the turn', async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    let inputOpenAtResult: boolean | undefined;
    let inputEnd: Promise<boolean> | undefined;
    scripts = [async function* (_o, { first, input }) {
      yield init('cc-bg');
      yield { type: 'system', subtype: 'task_started', task_id: 'bg1', session_id: 'cc-bg' };
      yield text('cc-bg', 'started');
      yield result('cc-bg', 2, 'started', first.uuid);
      // Closing the input is what makes the CLI exit and kill the job: it must still be open here.
      inputEnd = input.next().then((r) => !!r.done);
      inputOpenAtResult = await Promise.race([inputEnd.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 50))]);
      yield { type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', session_id: 'cc-bg' };
      yield text('cc-bg', 'done-marker-42');
      yield result('cc-bg', 2, 'done-marker-42');
    }];
    const events = await turn(sid, conv, ALICE, 'run it in the background');
    expect(inputOpenAtResult).toBe(true);
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toBe('started\n\ndone-marker-42');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1).type).toBe('done');
    expect(await inputEnd).toBe(true); // released once the turn ended
  });

  test("a resumed session's stale zero-turn result does not end the turn before the user's prompt is answered", async () => {
    reset();
    const sid = newSid(); const conv: ConvMessage[] = [];
    scripts = [ok('cc-st')];
    await turn(sid, conv, ALICE, 'hi');
    transcript('cc-st');
    scripts = [async function* (_o, { first }) {
      yield { type: 'system', subtype: 'task_notification', task_id: 'old', status: 'stopped', session_id: 'cc-st' };
      yield init('cc-st');
      yield { ...result('cc-st', 0, ''), queued_turn_count: 0, result_index: 0 };
      yield init('cc-st');
      yield text('cc-st', 'the job was killed');
      yield { ...result('cc-st', 2, 'the job was killed', first.uuid), result_index: 1 };
    }];
    const events = await turn(sid, conv, ALICE, "what's the status?");
    expect(calls[1].resume).toBe('cc-st');
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toBe('the job was killed');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'success' });
    expect(logs.some((l) => l.includes('Skipping result of an earlier turn'))).toBe(true);
  });
});
