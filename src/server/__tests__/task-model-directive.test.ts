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
