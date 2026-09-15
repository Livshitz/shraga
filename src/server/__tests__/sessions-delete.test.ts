import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import { acquireSessionLock, appendMessage, deleteSession, getSession, getSessionModel, releaseSessionLock, setClaudeResume, setSessionModel, upsertSession, writePartial } from '../sessions.ts';
import { createArtifact, getArtifactHtml } from '../artifacts/artifacts.service.ts';
import { addUnread, getUnreads } from '../unread.ts';
import { lookupIdempotent, rememberIdempotent } from '../idempotency.ts';
import { findSlackSessionBySessionId, getProactiveOrigin, registerProactiveMessage, registerThreadAlias } from '../slack/sessions.ts';
import { shortHash } from '../engine/claude-resume.ts';

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

test('deleteSession removes artifacts, unread markers, Slack mappings, idempotency keys, caches and the resume transcript', () => {
  const id = `delart-${Date.now()}`, other = `keepart-${Date.now()}`;
  const cfg = mkdtempSync(path.join(tmpdir(), 'cc-cfg-')), prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    for (const s of [id, other]) {
      upsertSession(s, 'private', { uid: 'bob', email: 'bob@x.test' });
      appendMessage(s, { id: 'm', role: 'user', blocks: [{ type: 'text', text: 'hi' }] });
      addUnread('bob', s, 'PRIVATE PREVIEW', 'response');
      rememberIdempotent('bob', `key-${s}`, s);
      registerThreadAlias('C1', `${s}.1`, s);
      registerProactiveMessage('C1', `${s}.2`, s, 't');
      mkdirSync(path.join(cfg, 'projects', 'slug'), { recursive: true });
      writeFileSync(path.join(cfg, 'projects', 'slug', `cc-${s}.jsonl`), 'transcript');
      setClaudeResume(s, { claudeSessionId: `cc-${s}`, configDirHash: shortHash(cfg), startedAt: 1, summaryKey: '', sections: {} });
      setSessionModel(s, 'model-x');
    }
    const art = createArtifact(id, { title: 't', html: '<p>PRIVATE-ARTIFACT-BODY</p>' });
    const keep = createArtifact(other, { title: 't', html: '<p>keep</p>' });
    expect(getArtifactHtml(id, art.id)).toContain('PRIVATE-ARTIFACT-BODY');
    expect(existsSync(dataPath('sessions', id, 'artifacts', `${art.id}.html`))).toBe(true);

    expect(deleteSession(id).ok).toBe(true);

    expect(existsSync(dataPath('sessions', id))).toBe(false);
    expect(getArtifactHtml(id, art.id)).toBeNull();
    expect(getUnreads('bob').sessions[id]).toBeUndefined();
    expect(lookupIdempotent('bob', `key-${id}`)).toBeNull();
    expect(findSlackSessionBySessionId(id)).toBeNull();
    expect(getProactiveOrigin('C1', `${id}.2`)).toBeNull();
    expect(existsSync(path.join(cfg, 'projects', 'slug', `cc-${id}.jsonl`))).toBe(false);
    expect(getSessionModel(id)).toBeUndefined();
    // The other conversation keeps every store.
    expect(getArtifactHtml(other, keep.id)).toContain('keep');
    expect(getUnreads('bob').sessions[other]).toBeDefined();
    expect(lookupIdempotent('bob', `key-${other}`)).toBe(other);
    expect(findSlackSessionBySessionId(other)).not.toBeNull();
    expect(getProactiveOrigin('C1', `${other}.2`)).not.toBeNull();
    expect(existsSync(path.join(cfg, 'projects', 'slug', `cc-${other}.jsonl`))).toBe(true);
    expect(getSessionModel(other)).toBe('model-x');
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(cfg, { recursive: true, force: true });
  }
});
