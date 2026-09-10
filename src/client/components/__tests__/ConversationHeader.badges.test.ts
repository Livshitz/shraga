import { describe, test, expect } from 'bun:test';
import { deriveRuntimeBadges } from '../ConversationHeader';

/**
 * The header must report what RAN, not what was requested.
 *
 * Reproduces the incident's exact data: a scheduled run requested engine `ext-agent` +
 * `cursor/composer-2.5`, but the unregistered engine was rerouted to `claude-code`, which ran
 * `claude-sonnet-5` on Anthropic. The header showed `ext-agent · cursor/composer-2.5` + `API·cursor` —
 * the wrong vendor on the billing chip, for a run already billed to Anthropic.
 */
describe('deriveRuntimeBadges', () => {
  test('the incident: a fallback run reports the engine/model that actually executed', () => {
    const b = deriveRuntimeBadges({
      requestedEngine: 'ext-agent',
      requestedModel: 'cursor/composer-2.5',
      actualEngine: 'claude-code',
      actualModel: 'claude-sonnet-5',
    });
    expect(b.engine).toBe('claude-code');
    expect(b.rawModel).toBe('claude-sonnet-5');
    expect(b.billingProvider).toBe('anthropic'); // was 'cursor' — the chip named the wrong vendor
    expect(b.engineMismatch).toBe('ext-agent'); // and the disagreement is now visible, not laundered
    expect(b.provenance).toBe('ran');
  });

  test('no mismatch chip when the run matches the request', () => {
    const b = deriveRuntimeBadges({
      requestedEngine: 'ext-agent',
      requestedModel: 'cursor/composer-2.5',
      actualEngine: 'ext-agent',
      actualModel: 'cursor/composer-2.5',
    });
    expect(b.engine).toBe('ext-agent');
    expect(b.rawModel).toBe('cursor/composer-2.5');
    expect(b.billingProvider).toBe('cursor');
    expect(b.engineMismatch).toBeUndefined();
    expect(b.engineIsNative).toBe(false);
  });

  test('a bare model id belongs to the engine that ran it — not assumed to be anthropic', () => {
    // The old rule was "no slash ⇒ anthropic", which mislabels any add-on engine running a bare id.
    const b = deriveRuntimeBadges({ actualEngine: 'ext-agent', actualModel: 'composer-2.5' });
    expect(b.billingProvider).toBe('ext-agent');
  });

  test('before any turn has run, the chips describe the SELECTION and say so', () => {
    // A pending selection and an executed runtime are different claims. The chips still have to tell
    // the user what the next turn will use — but must never present it as something that ran.
    const b = deriveRuntimeBadges({ requestedEngine: 'cursor', requestedModel: 'cursor/composer-2.5' });
    expect(b.provenance).toBe('pending');
    expect(b.engine).toBe('cursor');
    expect(b.rawModel).toBe('cursor/composer-2.5');
    expect(b.engineMismatch).toBeUndefined(); // nothing ran, so nothing can disagree with the request
  });

  test('an engine-less BARE recorded model is the model that RAN — with the engine left unnamed', () => {
    // 45 of 817 live sessions are this shape (written before `lastEngine` existed). Substituting the
    // REQUESTED model for it — the previous rule — reported a runtime that provably did not execute.
    // A bare id still cannot name a provider, so that half is reported unknown rather than guessed.
    const b = deriveRuntimeBadges({ requestedEngine: 'ext-agent', requestedModel: 'cursor/composer-2.5', actualModel: 'claude-sonnet-5' });
    expect(b.provenance).toBe('ran-model');
    expect(b.rawModel).toBe('claude-sonnet-5');
    expect(b.engine).toBeUndefined();
    expect(b.billingProvider).toBeUndefined();
    expect(b.engineMismatch).toBeUndefined(); // no engine ground truth ⇒ nothing to contradict
  });

  test('an engine-less PREFIXED recorded model still names its provider (pre-lastEngine sessions)', () => {
    // A `provider/` prefix is direct evidence of what was billed and needs no engine to vouch for it.
    const b = deriveRuntimeBadges({
      requestedEngine: 'ext-agent',
      requestedModel: 'cursor/composer-2.5',
      actualModel: 'anthropic/claude-sonnet-4-6',
    });
    expect(b.provenance).toBe('ran-model');
    expect(b.rawModel).toBe('anthropic/claude-sonnet-4-6');
    expect(b.billingProvider).toBe('anthropic'); // was 'cursor' — a provider that did not run
    expect(b.engine).toBeUndefined(); // and we still claim no engine ground truth
    expect(b.engineMismatch).toBeUndefined();
  });

  test('default when nothing is known at all', () => {
    const b = deriveRuntimeBadges({});
    expect(b.provenance).toBe('pending');
    expect(b.engine).toBe('claude-code');
    expect(b.billingProvider).toBe('anthropic');
  });
});
