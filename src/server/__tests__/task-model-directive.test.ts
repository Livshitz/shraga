import { describe, test, expect, beforeEach } from 'bun:test';
import { parseDirectives, setModelResolver } from '../directives.ts';

// These assert the NO-resolver behaviour (a bare `composer-2.5` is unresolvable, so the token is
// reported instead of silently becoming a model). The resolver is a module global that any other
// test file may have installed, and bun's file order differs between macOS and Linux CI — so own
// it here rather than inheriting whatever ran first.
beforeEach(() => setModelResolver(null));

// A scheduled run's runtime IS the prompt's leading directive — there is no stored pin behind it
// any more. These tests pin the shapes a schedule prompt actually carries (including the one the
// legacy-pin migration writes), so a pinned schedule cannot silently run on the instance default
// again (the phantom-field regression of 0.1.15).
describe('schedule prompt [model] directive', () => {
  test('alias prefix resolves and is stripped from the prompt', () => {
    const { prompt, directives } = parseDirectives('[haiku] Dispatcher tick: do the thing.');
    expect(directives.model).toBe('claude-haiku-4-5-20251001');
    expect(prompt).toBe('Dispatcher tick: do the thing.');
  });
  test('prefix survives multi-line prompts with appended sections', () => {
    const { directives } = parseDirectives('[haiku] Base prompt.\n\n---\nAdditional instructions for this run:\nmore');
    expect(directives.model).toBe('claude-haiku-4-5-20251001');
  });
  test('engine + provider-qualified model (the runner prefix shape) both resolve', () => {
    const { prompt, directives } = parseDirectives('[engine:agentx,model:cursor/composer-2.5] Do the thing.');
    expect(directives.engine).toBe('agentx');
    expect(directives.model).toBe('cursor/composer-2.5');
    expect(prompt).toBe('Do the thing.');
  });
  // A qualified id is NOT honoured bare: `[src/foo.ts]` is indistinguishable from it, and a second
  // bracket group would then be eaten as directives instead of staying prompt text.
  test('a qualified id is only honoured in key form', () => {
    expect(parseDirectives('[cursor/composer-2.5] hi').directives.model).toBeUndefined();
    expect(parseDirectives('[opus] [src/foo.ts] fix it').prompt).toBe('[src/foo.ts] fix it');
  });
});

// A schedule prompt may already open with its own [turns:N] group when runner.ts prepends
// `[model] `. Both groups must survive — the single-group parse dropped the second silently
// and downgraded the pinned model to the config default (feedox social runs, 08-17..08-19).
describe('stacked directive groups', () => {
  test('[turns:120][opus] keeps both', () => {
    const { prompt, directives } = parseDirectives('[turns:120][opus] Run the routine.');
    expect(directives.model).toBe('claude-opus-5');
    expect(directives.turns).toBe(120);
    expect(prompt).toBe('Run the routine.');
  });
  test('[opus] [turns:120] (runner prepend shape) keeps both', () => {
    const { directives } = parseDirectives('[opus] [turns:120] Run the routine.');
    expect(directives.model).toBe('claude-opus-5');
    expect(directives.turns).toBe(120);
  });
  test('non-directive bracket text is left in the prompt', () => {
    const { prompt, directives } = parseDirectives("[opus] [WARN] disk full");
    expect(directives.model).toBe('claude-opus-5');
    expect(prompt).toBe('[WARN] disk full');
  });
});
