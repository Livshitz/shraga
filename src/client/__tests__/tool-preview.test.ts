import { describe, it, expect } from 'bun:test';
import { toolPreview } from '../lib/tool-preview.ts';

describe('toolPreview', () => {
  it('shows the command, not the argument names', () => {
    // The regression: a Bash pill previewed as "command, background, description", making every
    // shell call — including a dispatched worker — look identical.
    expect(toolPreview({ command: 'bun run build', background: true, description: 'build' }))
      .toBe('bun run build');
  });

  it('prefers the identifying field over an earlier-declared one', () => {
    expect(toolPreview({ description: 'find files', glob_pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('collapses whitespace and truncates', () => {
    expect(toolPreview({ command: 'a\n  b\tc' })).toBe('a b c');
    expect(toolPreview({ command: 'x'.repeat(200) }).endsWith('…')).toBe(true);
    expect(toolPreview({ command: 'x'.repeat(200) }).length).toBe(121);
  });

  it('falls back to the first string value, then to keys', () => {
    expect(toolPreview({ weird_field: 'hello' })).toBe('hello');
    expect(toolPreview({ a: 1, b: true })).toBe('a, b');
  });

  it('handles a string input', () => {
    expect(toolPreview('raw input')).toBe('raw input');
  });
});
