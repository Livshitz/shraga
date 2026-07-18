import { existsSync, readFileSync } from 'node:fs';
import { createArtifact, updateArtifact, findByFilePath } from './artifacts.service.ts';

const PREFIX = '[artifacts:handler]';
const ARTIFACT_META_RE = /<!--\s*artifact:\s*(\{[^}]+\})\s*-->/;

interface ArtifactMeta {
  title?: string;
  dimensions?: [number, number];
  id?: string;
}

function parseMeta(html: string): ArtifactMeta | null {
  const match = html.match(ARTIFACT_META_RE);
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch (err) { console.error(PREFIX, 'failed to parse artifact meta:', err); return null; }
}

function emitEvent(sessionId: string, a: { id: string; title: string; dimensions: [number, number]; version: number }) {
  return { type: 'artifact', id: a.id, sessionId, title: a.title, dimensions: a.dimensions, version: a.version };
}

/**
 * Intercepts Write and Edit tool calls to detect artifact creation/updates.
 * - Write: full content available in input, parsed directly
 * - Edit: file already modified on disk by SDK; re-read to detect artifact + refresh
 */
export function handleArtifactToolUse(sessionId: string, tool: string, input: unknown): object | null {
  if (tool === 'Write') return handleWrite(sessionId, input);
  if (tool === 'Edit') return handleEdit(sessionId, input);
  return null;
}

function handleWrite(sessionId: string, input: unknown): object | null {
  const inp = input as { file_path?: string; content?: string };
  if (!inp.file_path || !inp.content) return null;

  const meta = parseMeta(inp.content);
  if (!meta) return null;

  const title = meta.title || 'Untitled';
  const dimensions = meta.dimensions || [1080, 1080];

  if (meta.id) {
    const updated = updateArtifact(sessionId, meta.id, { html: inp.content, title, dimensions });
    if (updated) return emitEvent(sessionId, updated);
  }

  const artifact = createArtifact(sessionId, { title, html: inp.content, dimensions, filePath: inp.file_path });
  return emitEvent(sessionId, artifact);
}

function handleEdit(sessionId: string, input: unknown): object | null {
  const inp = input as { file_path?: string };
  if (!inp.file_path) return null;

  // Check if this file path belongs to a known artifact
  const existing = findByFilePath(sessionId, inp.file_path);
  if (!existing) {
    // Could be an Edit on a file that happens to have artifact meta (rare)
    // We'd need the file to already exist on disk — SDK applies the edit before we see it
    if (!existsSync(inp.file_path)) return null;
    try {
      const html = readFileSync(inp.file_path, 'utf-8');
      const meta = parseMeta(html);
      if (!meta) return null;
      const artifact = createArtifact(sessionId, {
        title: meta.title || 'Untitled',
        html,
        dimensions: meta.dimensions || [1080, 1080],
        filePath: inp.file_path,
      });
      return emitEvent(sessionId, artifact);
    } catch { return null; }
  }

  // Known artifact — re-read from disk to get updated content
  if (!existsSync(inp.file_path)) return null;
  try {
    const html = readFileSync(inp.file_path, 'utf-8');
    const meta = parseMeta(html);
    const updated = updateArtifact(sessionId, existing.id, {
      html,
      title: meta?.title || existing.title,
      dimensions: meta?.dimensions || existing.dimensions,
    });
    if (updated) return emitEvent(sessionId, updated);
  } catch (err) {
    console.error(PREFIX, 'failed to re-read edited artifact:', err);
  }
  return null;
}
