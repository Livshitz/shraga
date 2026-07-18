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
});
