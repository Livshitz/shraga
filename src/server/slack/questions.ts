// Slack-medium implementation of the AskUserQuestion flow: render the agent's
// questions as a Block Kit form (radio_buttons / checkboxes + Submit button) and
// resolve the pending turn when the user clicks Submit via Slack interactivity.
import { slackPost } from './api.ts';
import { handlePollVote, handlePollClose } from '../polls.ts';
import type { QuestionHandler, AskQuestion, QuestionAnswers } from '../claude.ts';

const PREFIX = '[slack-q]';
const TTL_MS = 15 * 60_000; // questions expire after 15min → agent self-decides
const SLACK_MAX = 75; // Slack option label/value max length

type Ctx = { channel: string; threadTs?: string; useUserToken?: boolean };
type Pending = Ctx & {
  resolve: (answers: QuestionAnswers | null) => void;
  questions: AskQuestion[];
  messageTs?: string;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

const trunc = (s: string, n = SLACK_MAX) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function buildBlocks(id: string, questions: AskQuestion[]): unknown[] {
  const blocks: unknown[] = [];
  questions.forEach((q, i) => {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${q.question}*` } });
    const options = q.options.map((o) => ({
      text: { type: 'plain_text', text: trunc(o.label) },
      value: trunc(o.label),
      ...(o.description ? { description: { type: 'plain_text', text: trunc(o.description) } } : {}),
    }));
    blocks.push({
      type: 'actions',
      block_id: `q${i}`,
      elements: [{ type: q.multiSelect ? 'checkboxes' : 'radio_buttons', action_id: `q${i}`, options }],
    });
  });
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', action_id: `submit:${id}`, style: 'primary', value: id, text: { type: 'plain_text', text: 'Submit' } }],
  });
  return blocks;
}

/** Build a QuestionHandler bound to a Slack channel/thread for the current turn. */
export function makeSlackQuestionHandler(ctx: Ctx): QuestionHandler {
  return async (id, questions) => {
    const res = await slackPost(
      'chat.postMessage',
      { channel: ctx.channel, thread_ts: ctx.threadTs, text: 'I have a few questions for you:', blocks: buildBlocks(id, questions) },
      ctx.useUserToken,
    ).catch((err) => { console.error(`${PREFIX} post failed:`, (err as Error)?.message); return null; });
    if (!res?.ok) return null;
    console.log(`${PREFIX} posted question ${id} (${questions.length}q) to ${ctx.channel}`);
    return new Promise<QuestionAnswers | null>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) { console.log(`${PREFIX} ${id} timed out`); resolve(null); }
      }, TTL_MS);
      pending.set(id, { ...ctx, resolve, questions, messageTs: res.ts, timer });
    });
  };
}

function parseAnswers(state: any, questions: AskQuestion[]): QuestionAnswers {
  const answers: QuestionAnswers = {};
  questions.forEach((q, i) => {
    const block = state?.[`q${i}`]?.[`q${i}`];
    if (!block) return;
    if (q.multiSelect) {
      const labels = (block.selected_options ?? []).map((o: any) => o.value);
      if (labels.length) answers[q.question] = labels;
    } else if (block.selected_option) {
      answers[q.question] = block.selected_option.value;
    }
  });
  return answers;
}

/**
 * Handle a Slack interactivity payload (block_actions). Returns true if it
 * resolved a pending question. Selection changes (non-submit actions) are ignored.
 */
export async function handleSlackInteraction(payload: any): Promise<boolean> {
  if (payload?.type !== 'block_actions') return false;
  const userId = payload.user?.id as string | undefined;

  // Poll / directed-question votes — action_id `poll:vote:<id>:<optIdx>` or `poll:close:<id>`.
  const pollAction = (payload.actions ?? []).find((a: any) => typeof a.action_id === 'string' && a.action_id.startsWith('poll:'));
  if (pollAction) {
    const [, verb, pollId, optIdx] = (pollAction.action_id as string).split(':');
    if (verb === 'close') await handlePollClose(pollId);
    else if (verb === 'vote' && userId) await handlePollVote(pollId, userId, Number(optIdx));
    return true;
  }

  const submit = (payload.actions ?? []).find((a: any) => typeof a.action_id === 'string' && a.action_id.startsWith('submit:'));
  if (!submit) return false;
  const id = submit.value as string;
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  const answers = parseAnswers(payload.state?.values, p.questions);
  if (p.messageTs) {
    const summary = Object.entries(answers).map(([q, a]) => `• *${q}* — ${Array.isArray(a) ? a.join(', ') : a}`).join('\n') || '_(no selection)_';
    await slackPost('chat.update', { channel: p.channel, ts: p.messageTs, text: '✅ Got your answers.', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ Got your answers:\n${summary}` } }] }, p.useUserToken).catch(() => {});
  }
  console.log(`${PREFIX} resolved question ${id} (${Object.keys(answers).length} answered)`);
  p.resolve(Object.keys(answers).length ? answers : null);
  return true;
}
