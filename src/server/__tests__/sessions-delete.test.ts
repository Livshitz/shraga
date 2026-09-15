import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import { acquireSessionLock, appendMessage, deleteSession, getSession, releaseSessionLock, upsertSession, writePartial } from '../sessions.ts';

test('deleteSession removes meta, conversation files and uploads; refuses while running; never touches audit', () => {
  const id = `del-${Date.now()}`;
  upsertSession(id, 'secret prompt', { uid: 'u1', email: 'u1@x.test' });
  appendMessage(id, { id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }] });
  writePartial(id, [{ type: 'text', text: 'partial' }]);
  const conv = dataPath('conversations');
  writeFileSync(path.join(conv, `${id}.summary.md`), 's');
  writeFileSync(path.join(conv, `${id}.trace.yaml`), 't');
  mkdirSync(dataPath('uploads', id), { recursive: true });
  writeFileSync(dataPath('uploads', id, 'a.png'), 'x');
  const other = `keep-${Date.now()}`;
  upsertSession(other, 'other', { uid: 'u2', email: 'u2@x.test' });
  appendMessage(other, { id: 'm2', role: 'user', blocks: [{ type: 'text', text: 'keep' }] });
  // Sentinel, not a YYYY-MM.jsonl: the preload DATA_DIR is shared by every test file, and a fake month file would break
  // the real audit chain other files verify.
  mkdirSync(dataPath('audit'), { recursive: true });
  const auditFile = dataPath('audit', `sentinel-${id}.txt`);
  writeFileSync(auditFile, id);

  const ac = new AbortController();
  expect(acquireSessionLock(id, 'web', ac)).toBe(true);
  expect(deleteSession(id)).toEqual({ ok: false, reason: 'running' });
  expect(getSession(id)).toBeDefined();
  releaseSessionLock(id, ac);

  const r = deleteSession(id);
  expect(r.ok && r.meta.uid).toBe('u1');
  expect(getSession(id)).toBeUndefined();
  for (const f of ['jsonl', 'partial.json', 'summary.md', 'trace.yaml']) expect(existsSync(path.join(conv, `${id}.${f}`))).toBe(false);
  expect(existsSync(dataPath('uploads', id))).toBe(false);
  expect(existsSync(auditFile)).toBe(true);
  expect(getSession(other)).toBeDefined();
  expect(existsSync(path.join(conv, `${other}.jsonl`))).toBe(true);

  expect(deleteSession(id)).toEqual({ ok: false, reason: 'not_found' });
  expect(deleteSession('../sessions')).toEqual({ ok: false, reason: 'invalid' });
  expect(existsSync(dataPath('sessions.json'))).toBe(true);
});
