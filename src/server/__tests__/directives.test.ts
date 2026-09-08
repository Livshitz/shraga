import { describe, test, expect } from 'bun:test';
import { parseDirectives, MODEL_ALIASES } from '../directives.ts';

describe('parseDirectives', () => {
  test('positional: model + turns', () => {
    const r = parseDirectives('[opus, 50] hello world');
    expect(r.prompt).toBe('hello world');
    expect(r.directives.model).toBe(MODEL_ALIASES.opus);
    expect(r.directives.turns).toBe(50);
  });

  test('explicit key:value', () => {
    const r = parseDirectives('[model:sonnet, turns:20] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives.model).toBe(MODEL_ALIASES.sonnet);
    expect(r.directives.turns).toBe(20);
  });

  test('mixed positional + explicit', () => {
    const r = parseDirectives('[opus, turns:50] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives.model).toBe(MODEL_ALIASES.opus);
    expect(r.directives.turns).toBe(50);
  });

  test('model only', () => {
    const r = parseDirectives('[opus] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives.model).toBe(MODEL_ALIASES.opus);
    expect(r.directives.turns).toBeUndefined();
  });

  test('turns only (explicit)', () => {
    const r = parseDirectives('[turns:30] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives.turns).toBe(30);
    expect(r.directives.model).toBeUndefined();
  });

  test('no directives', () => {
    const r = parseDirectives('hello world');
    expect(r.prompt).toBe('hello world');
    expect(r.directives).toEqual({});
  });

  test('unknown alias ignored', () => {
    const r = parseDirectives('[unknown] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives).toEqual({});
  });

  test('empty brackets', () => {
    const r = parseDirectives('[] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives).toEqual({});
  });

  test('leading whitespace', () => {
    const r = parseDirectives('  [opus] hi');
    expect(r.prompt).toBe('hi');
    expect(r.directives.model).toBe(MODEL_ALIASES.opus);
  });

  test('haiku alias', () => {
    const r = parseDirectives('[haiku] test');
    expect(r.prompt).toBe('test');
    expect(r.directives.model).toBe(MODEL_ALIASES.haiku);
  });

  test('positional turns as second arg', () => {
    const r = parseDirectives('[sonnet, 10] go');
    expect(r.directives.model).toBe(MODEL_ALIASES.sonnet);
    expect(r.directives.turns).toBe(10);
  });

  test('multiline prompt preserved', () => {
    const r = parseDirectives('[opus] line1\nline2');
    expect(r.prompt).toBe('line1\nline2');
  });

  // An EXPLICIT model selection that resolves to nothing must be REPORTED, not dropped — dropping it
  // ran the turn on config.model, a different model than the caller chose (streamChat turns
  // `unresolvedModel` into a turn `error`). The blast radius is the point: ordinary bracketed prose
  // must stay prose.
  describe('unresolvable model selection', () => {
    test('[model:x] key form reports the token', () => {
      const r = parseDirectives('[model:composer-2.5] hi');
      expect(r.unresolvedModel).toBe('composer-2.5');
      expect(r.directives.model).toBeUndefined();
    });

    test('bare positional in a PROVEN directive group reports it', () => {
      const r = parseDirectives('[composer-2.5, turns:5] hi');
      expect(r.unresolvedModel).toBe('composer-2.5');
      expect(r.directives.turns).toBe(5);
    });

    test('bracketed prose stays prose — no error', () => {
      for (const text of ['[some bracketed prose] hi', '[WARN] something happened', '[fix src/foo.ts] go']) {
        expect(parseDirectives(text).unresolvedModel).toBeUndefined();
      }
    });

    test('a resolvable or provider-qualified model reports nothing', () => {
      expect(parseDirectives('[model:opus] hi').unresolvedModel).toBeUndefined();
      expect(parseDirectives('[model:cursor/composer-2.5] hi').unresolvedModel).toBeUndefined();
    });
  });
});
