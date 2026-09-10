/**
 * The schedule editor's runtime picker, driven through a real React render.
 *
 * The selection has no stored field behind it: the prompt's leading `[engine:…,model:…]` directive
 * IS the selection. So the thing to prove at this level is that the rendered control agrees with
 * the text — a <select> whose value matches no option silently renders the FIRST one while state
 * says otherwise, which would show a runtime other than the one that will actually run.
 */
// See use-session-list.test.tsx: the registrator installs DOM + fetch/Response globals process-wide
// for every later test file, so they must be handed back when this file is done.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { describe, it, expect, afterAll, beforeEach } from 'bun:test';

afterAll(async () => {
  // React's scheduler drains through a MessageChannel task; unregistering while one is still queued
  // makes it fire against a torn-down `window` and reports a file-level error on a green run.
  await new Promise((r) => setTimeout(r, 20));
  await GlobalRegistrator.unregister();
});
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduleEditor } from '../components/schedules/ScheduleEditor.tsx';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The registry a real /api/engines serves (shape verified against boot.ts's handler).
const ENGINES = {
  engines: [
    { name: 'claude-code', models: [{ value: 'claude-sonnet-5', label: 'Sonnet 5' }, { value: 'claude-haiku-4-5', label: 'Haiku 4.5' }] },
    { name: 'ext-agent', models: [{ value: 'cursor/composer-2.5', label: 'Composer 2.5' }, { value: 'anthropic/claude-sonnet-5', label: 'Sonnet 5 (API)' }] },
  ],
  multiEngine: true,
};

beforeEach(() => {
  (globalThis as any).fetch = async (url: string) =>
    new Response(JSON.stringify(url.includes('/api/engines') ? ENGINES : {}), { headers: { 'content-type': 'application/json' } });
});

async function mount(prompt: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let saved: any = null;
  const initial = {
    id: 'x', name: 'n', enabled: true,
    trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    task: { kind: 'prompt', prompt },
  } as any;
  await act(async () => {
    root.render(createElement(ScheduleEditor, {
      initial,
      getToken: async () => 'tok',
      onSave: async (s: any) => { saved = s; },
      onCancel: () => {},
    }));
  });
  // Let the /api/engines promise settle so the picker leaves its read-only loading state.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const selects = [...host.querySelectorAll('select')] as HTMLSelectElement[];
  return { host, root, selects, save: async () => {
      const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement;
      await act(async () => { btn.click(); });
      await act(async () => { await Promise.resolve(); });
      return saved;
    } };
}

describe('ScheduleEditor runtime picker', () => {
  it('shows the selection a directive already carries — including one implied by a bare model', async () => {
    // The real shape of 11 of the 15 live schedules: a model-only pin whose engine is inferred.
    const { selects, root } = await mount('[model:cursor/composer-2.5] Run the daily social routine.');
    expect(selects.length).toBe(2);
    expect(selects[0].value).toBe('ext-agent');              // inferred from the model, as the server does
    expect(selects[1].value).toBe('cursor/composer-2.5');
    expect(selects[0].disabled).toBe(false);              // registry loaded ⇒ editable
    root.unmount();
  });

  it('no directive ⇒ both selects sit on the agent-config default', async () => {
    const { selects, root } = await mount('Just do the thing.');
    expect(selects[0].value).toBe('');
    expect(selects[1].value).toBe('');
    root.unmount();
  });

  it('a value this server does not offer is shown as itself, never silently swapped', async () => {
    // Hand-typed: sonnet belongs to claude-code, so ext-agent's list does not contain it. A plain
    // <select> would render ext-agent's FIRST model here and report a runtime that will not run.
    const { selects, root } = await mount('[engine:ext-agent,model:claude-sonnet-5] go');
    expect(selects[1].value).toBe('claude-sonnet-5');
    const shown = [...selects[1].querySelectorAll('option')].find((o) => (o as HTMLOptionElement).value === 'claude-sonnet-5')!;
    expect(shown.textContent).toContain('not offered by this engine');
    root.unmount();
  });

  it('changing the model rewrites the directive in place and leaves the body alone', async () => {
    const body = 'Run the daily social routine for Elya.\n\n---\nmore';
    const { host, selects, save, root } = await mount(`[model:cursor/composer-2.5] [turns:120] ${body}`);
    const model = selects[1];
    await act(async () => {
      model.value = 'claude-haiku-4-5';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(`[model:claude-haiku-4-5,turns:120] ${body}`);
    const saved = await save();
    expect(saved.task).toEqual({ kind: 'prompt', prompt: `[model:claude-haiku-4-5,turns:120] ${body}` });
    root.unmount();
  });
});
