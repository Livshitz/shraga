import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import { getMcpConfig, type McpHttpServerConfig } from '../mcp.ts';

const UID = 'http-env-test';

function writeConfig(config: Record<string, unknown>) {
  mkdirSync(dataPath('mcps'), { recursive: true });
  writeFileSync(path.join(dataPath('mcps'), `${UID}.json`), JSON.stringify(config, null, 2));
}

describe('http MCP env resolution', () => {
  const saved = process.env.MEDIA_POD_TOKEN;
  beforeAll(() => { process.env.MEDIA_POD_TOKEN = 's3cret-value'; });
  afterAll(() => { if (saved == null) delete process.env.MEDIA_POD_TOKEN; else process.env.MEDIA_POD_TOKEN = saved; });

  test('resolves $VAR and ${VAR} in headers and url', () => {
    writeConfig({
      pod: { type: 'http', url: 'https://pod.example/mcp?k=${MEDIA_POD_TOKEN}', headers: { Authorization: 'Bearer $MEDIA_POD_TOKEN' } },
    });
    const pod = getMcpConfig(UID).pod as McpHttpServerConfig;
    expect(pod.headers?.Authorization).toBe('Bearer s3cret-value');
    expect(pod.url).toBe('https://pod.example/mcp?k=s3cret-value');
  });

  test('entries without placeholders are untouched', () => {
    writeConfig({ plain: { type: 'http', url: 'https://plain.example/mcp', headers: { 'X-A': 'literal' } } });
    expect(getMcpConfig(UID).plain).toEqual({ type: 'http', url: 'https://plain.example/mcp', headers: { 'X-A': 'literal' } });
  });

  test('skips an entry whose placeholders are all unset (no bare "Bearer " credential)', () => {
    writeConfig({ missing: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer $NOPE_UNSET_VAR' } } });
    expect(getMcpConfig(UID).missing).toBeUndefined();
  });
});
