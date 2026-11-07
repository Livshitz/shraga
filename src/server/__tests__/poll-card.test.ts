import { describe, test, expect } from 'bun:test';
import { closedCardBlocks, type PollRecord } from '../polls.ts';

// A post_slack_card card registers as a directed question. On close it must keep its content
// (header, table…) and replace only the button rows — a poll results view would erase the card.
const card = (votes: Record<string, number[]>): PollRecord => ({
  pollId: 'c1', title: 'Signups', kind: 'question', options: [{ label: 'Approve' }, { label: 'Reject' }],
  channel: 'D1', ts: '1.1', votes, status: 'closed', sessionId: 's', uid: 'u', createdAt: 0,
  cardBlocks: [
    { type: 'header', text: { type: 'plain_text', text: 'Signups' } },
    { type: 'data_table', rows: [] },
    { type: 'actions', elements: [{ type: 'button', action_id: 'poll:vote:c1:0' }, { type: 'button', action_id: 'poll:vote:c1:1' }] },
  ],
});

describe('closed card', () => {
  test('keeps the content and names the choice instead of the buttons', () => {
    const blocks = closedCardBlocks(card({ U1: [1] })) as any[];
    expect(blocks.map((b) => b.type)).toEqual(['header', 'data_table', 'context']);
    expect(blocks[2].elements[0].text).toBe('✅ <@U1> chose *Reject*');
  });
  test('closed without a click says so', () => {
    expect((closedCardBlocks(card({})) as any[])[2].elements[0].text).toContain('without an answer');
  });
});
