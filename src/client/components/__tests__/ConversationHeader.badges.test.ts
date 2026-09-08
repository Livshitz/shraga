import { describe, test, expect } from 'bun:test';
import { deriveRuntimeBadges } from '../ConversationHeader';

/**
 * The header must report what RAN, not what was requested.
 *
 * Reproduces the incident's exact data: a scheduled run requested engine `agentx` +
 * `cursor/composer-2.5`, but the unregistered engine was rerouted to `claude-code`, which ran
 * `claude-sonnet-5` on Anthropic. The header showed `agentx · cursor/composer-2.5` + `API·cursor` —
 * the wrong vendor on the billing chip, for a run already billed to Anthropic.
 */
describe('deriveRuntimeBadges', () => {
  test('the incident: a fallback run reports the engine/model that actually executed', () => {
    const b = deriveRuntimeBadges({
      requestedEngine: 'agentx',
      requestedModel: 'cursor/composer-2.5',
      actualEngine: 'claude-code',
      actualModel: 'claude-sonnet-5',
    });
    expect(b.engine).toBe('claude-code');
    expect(b.rawModel).toBe('claude-sonnet-5');
    expect(b.billingProvider).toBe('anthropic'); // was 'cursor' — the chip named the wrong vendor
    expect(b.engineMismatch).toBe('agentx'); // and the disagreement is now visible, not laundered
  });

  test('no mismatch chip when the run matches the request', () => {
    const b = deriveRuntimeBadges({
      requestedEngine: 'agentx',
      requestedModel: 'cursor/composer-2.5',
      actualEngine: 'agentx',
      actualModel: 'cursor/composer-2.5',
    });
    expect(b.engine).toBe('agentx');
    expect(b.rawModel).toBe('cursor/composer-2.5');
    expect(b.billingProvider).toBe('cursor');
    expect(b.engineMismatch).toBeUndefined();
    expect(b.engineIsNative).toBe(false);
  });

  test('a bare model id belongs to the engine that ran it — not assumed to be anthropic', () => {
    // The old rule was "no slash ⇒ anthropic", which mislabels any add-on engine running a bare id.
    const b = deriveRuntimeBadges({ actualEngine: 'agentx', actualModel: 'composer-2.5' });
    expect(b.billingProvider).toBe('agentx');
  });

  test('before any turn has run, it falls back to the REQUEST (and claims no ground truth)', () => {
    const b = deriveRuntimeBadges({ requestedEngine: 'cursor', requestedModel: 'cursor/composer-2.5' });
    expect(b.engine).toBe('cursor');
    expect(b.rawModel).toBe('cursor/composer-2.5');
    expect(b.engineMismatch).toBeUndefined();
  });

  test('an engine-less BARE recorded model is never trusted alone — unreadable without its engine', () => {
    // A bare id says nothing about who billed it, so it cannot stand in for the requested model.
    const b = deriveRuntimeBadges({ requestedEngine: 'agentx', requestedModel: 'cursor/composer-2.5', actualModel: 'claude-sonnet-5' });
    expect(b.rawModel).toBe('cursor/composer-2.5');
    expect(b.engine).toBe('agentx');
  });

  test('an engine-less PREFIXED recorded model still names its provider (pre-lastEngine sessions)', () => {
    // Every session written before `lastEngine` existed has `lastModel` and no engine. Dropping the
    // recorded model there made the header report the REQUESTED provider — the exact false claim this
    // module exists to prevent. A `provider/` prefix is direct evidence of what was billed.
    const b = deriveRuntimeBadges({
      requestedEngine: 'agentx',
      requestedModel: 'cursor/composer-2.5',
      actualModel: 'anthropic/claude-sonnet-4-6',
    });
    expect(b.rawModel).toBe('anthropic/claude-sonnet-4-6');
    expect(b.billingProvider).toBe('anthropic'); // was 'cursor' — a provider that did not run
    expect(b.engine).toBe('agentx'); // and we still claim no engine ground truth
    expect(b.engineMismatch).toBeUndefined();
  });

  test('default when nothing is known at all', () => {
    const b = deriveRuntimeBadges({});
    expect(b.engine).toBe('claude-code');
    expect(b.billingProvider).toBe('anthropic');
  });
});
