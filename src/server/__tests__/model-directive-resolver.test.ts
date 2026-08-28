import { describe, expect, it, afterEach } from 'bun:test';
import { parseDirectives, setModelResolver } from '../directives.ts';

// The engine registry injects this in initEngines(); tests stub it so directives.ts stays pure.
const stub = (map: Record<string, { model: string; engine: string }>) =>
  setModelResolver((t) => map[t] ?? null);

afterEach(() => setModelResolver(null));

describe('engine-owned model directives', () => {
  it('resolves a model the alias table does not know, and implies its engine', () => {
    stub({ 'composer-2.5': { model: 'cursor/composer-2.5', engine: 'agentx' } });
    const r = parseDirectives('[composer-2.5] lfg');
    expect(r.prompt).toBe('lfg');
    expect(r.directives.model).toBe('cursor/composer-2.5');
    expect(r.directives.engine).toBe('agentx');
  });

  it('honours the same token in key form', () => {
    stub({ 'composer-2.5': { model: 'cursor/composer-2.5', engine: 'agentx' } });
    expect(parseDirectives('[model:composer-2.5] hi').directives).toMatchObject({ model: 'cursor/composer-2.5', engine: 'agentx' });
  });

  it('never overrides an explicit engine directive', () => {
    stub({ 'composer-2.5': { model: 'cursor/composer-2.5', engine: 'agentx' } });
    expect(parseDirectives('[engine:cursor,model:composer-2.5] hi').directives.engine).toBe('cursor');
  });

  it('leaves an unresolvable token alone (still a dropped directive, still warns)', () => {
    stub({});
    expect(parseDirectives('[nope] hi').directives.model).toBeUndefined();
  });

  it('keeps prompt text that merely looks like a bracket group', () => {
    stub({});
    const r = parseDirectives('[sonnet] [WARN] boom');
    expect(r.directives.model).toBeDefined();
    expect(r.prompt).toBe('[WARN] boom');
  });
});
