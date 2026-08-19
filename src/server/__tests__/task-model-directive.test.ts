import { describe, test, expect } from 'bun:test';
import { parseDirectives } from '../directives.ts';

// task.model flows into the run as a [model] prompt-directive prefix (runner.ts prompt
// synthesis). These tests pin the two halves of that contract: the prefix parses back out
// and resolves through MODEL_ALIASES — so a schedule with task.model 'haiku' cannot
// silently run on the instance default again (the phantom-field regression of 0.1.15).
describe('scheduler task.model → [model] directive', () => {
  test('alias prefix resolves and is stripped from the prompt', () => {
    const { prompt, directives } = parseDirectives('[haiku] Dispatcher tick: do the thing.');
    expect(directives.model).toBe('claude-haiku-4-5-20251001');
    expect(prompt).toBe('Dispatcher tick: do the thing.');
  });
  test('prefix survives multi-line prompts with appended sections', () => {
    const { directives } = parseDirectives('[haiku] Base prompt.\n\n---\nAdditional instructions for this run:\nmore');
    expect(directives.model).toBe('claude-haiku-4-5-20251001');
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
