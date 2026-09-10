import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readRuntimeDirective, writeRuntimeDirective } from '../prompt-directives.ts';
import { setModelResolver } from '../../../server/directives.ts';
import { makeModelResolver } from '../../../server/engine/model-resolver.ts';

// The picker resolves bare model tokens against the LIVE registry, exactly as the server parser
// does — a client that disagrees strips a token the server still reads, or keeps one it doesn't.
beforeAll(() => {
  setModelResolver(makeModelResolver(() => [
    { name: 'claude-code', models: [{ value: 'claude-sonnet-5' }] },
    { name: 'ext-agent', models: [{ value: 'cursor/composer-2.5' }, { value: 'anthropic/claude-opus-5' }] },
  ]));
});

// The resolver is a module global shared with every other test file in the run — leaving this one
// installed makes a later file's `[token]` resolve against THIS registry. Order currently hides it;
// don't rely on order.
afterAll(() => setModelResolver(null));

describe('readRuntimeDirective', () => {
  test('reads a directive the user typed by hand', () => {
    expect(readRuntimeDirective('[engine:ext-agent,model:cursor/composer-2.5] do it'))
      .toEqual({ engine: 'ext-agent', model: 'cursor/composer-2.5', engineExplicit: true });
  });
  test('a bare engine-owned token implies its engine, same as the server — but not as a choice', () => {
    expect(readRuntimeDirective('[composer-2.5] do it'))
      .toEqual({ engine: 'ext-agent', model: 'cursor/composer-2.5', engineExplicit: false });
    // Same for the key form: only `engine:` makes it a choice.
    expect(readRuntimeDirective('[model:cursor/composer-2.5] do it').engineExplicit).toBe(false);
  });
  test('no directive ⇒ no selection (follows agent config)', () => {
    expect(readRuntimeDirective('just do the thing')).toEqual({ engine: undefined, model: undefined, engineExplicit: false });
  });
});

describe('writeRuntimeDirective', () => {
  test('round-trips: what is written is what is read back', () => {
    const out = writeRuntimeDirective('do the thing', { engine: 'ext-agent', model: 'cursor/composer-2.5' });
    expect(readRuntimeDirective(out)).toMatchObject({ engine: 'ext-agent', model: 'cursor/composer-2.5' });
  });

  test('an engine the model already implies is not written', () => {
    // 11 of the 15 live schedules carry a model-only directive whose engine is inferred. Emitting the
    // inferred engine would stamp a pin the user never chose onto every one of them the moment the
    // picker is touched — and re-selecting the current selection would stop being a no-op.
    const p = '[model:cursor/composer-2.5] go';
    expect(writeRuntimeDirective(p, readRuntimeDirective(p))).toBe(p);
    expect(writeRuntimeDirective('go', { engine: 'ext-agent', model: 'cursor/composer-2.5' })).toBe('[model:cursor/composer-2.5] go');
    // ...but an engine the model does NOT imply is a real choice and is kept.
    expect(writeRuntimeDirective('go', { engine: 'claude-code', model: 'cursor/composer-2.5' }))
      .toBe('[engine:claude-code,model:cursor/composer-2.5] go');
    // ...as is an engine chosen with no model to imply it.
    expect(writeRuntimeDirective('go', { engine: 'ext-agent' })).toBe('[engine:ext-agent] go');
  });

  test('replaces in place instead of stacking a second pin', () => {
    let p = writeRuntimeDirective('do it', { engine: 'ext-agent', model: 'cursor/composer-2.5' });
    p = writeRuntimeDirective(p, { engine: 'claude-code', model: 'claude-sonnet-5' });
    expect(p).toBe('[model:claude-sonnet-5] do it');
  });

  test('every other directive survives, in both group shapes', () => {
    expect(writeRuntimeDirective('[turns:120,think] Run the routine.', { model: 'claude-sonnet-5' }))
      .toBe('[model:claude-sonnet-5,turns:120,think] Run the routine.');
    // The runner's old prepend shape: two consecutive groups, merged on rewrite.
    expect(writeRuntimeDirective('[model:composer-2.5] [turns:120] Run.', { engine: 'claude-code' }))
      .toBe('[engine:claude-code,turns:120] Run.');
  });

  test('a BARE model token is replaced, not left behind as a second selection', () => {
    expect(writeRuntimeDirective('[composer-2.5] go', { model: 'claude-sonnet-5' }))
      .toBe('[model:claude-sonnet-5] go');
  });

  test('clearing the selection leaves the prompt (and its other directives) intact', () => {
    expect(writeRuntimeDirective('[engine:ext-agent,model:cursor/composer-2.5] go', {})).toBe('go');
    expect(writeRuntimeDirective('[engine:ext-agent,turns:9] go', {})).toBe('[turns:9] go');
  });

  test('a prompt body that legitimately opens with bracketed prose is never swallowed', () => {
    // The server parser consumes its first group even when it is nonsense (a long-standing contract).
    // An editor must not: doing so would delete the first line of the user's prompt on every save.
    expect(writeRuntimeDirective('[WARN] disk full — investigate', { model: 'claude-sonnet-5' }))
      .toBe('[model:claude-sonnet-5] [WARN] disk full — investigate');
    expect(writeRuntimeDirective('[see notes] do it', {})).toBe('[see notes] do it');
  });

  test('the body is preserved verbatim, newlines and all', () => {
    const body = 'line one\n\n---\nline two';
    expect(writeRuntimeDirective(body, { engine: 'ext-agent' })).toBe(`[engine:ext-agent] ${body}`);
    expect(writeRuntimeDirective(`[engine:ext-agent] ${body}`, {})).toBe(body);
  });
});
