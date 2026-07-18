import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import type { Artifact, ArtifactIndex } from './artifacts.types.ts';

const PREFIX = '[artifacts]';

function artifactsDir(sessionId: string): string {
  return dataPath(`sessions/${sessionId}/artifacts`);
}

function indexPath(sessionId: string): string {
  return path.join(artifactsDir(sessionId), '_index.json');
}

function htmlPath(sessionId: string, id: string): string {
  return path.join(artifactsDir(sessionId), `${id}.html`);
}

function loadIndex(sessionId: string): ArtifactIndex {
  const p = indexPath(sessionId);
  if (!existsSync(p)) return { artifacts: [] };
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return { artifacts: [] }; }
}

function saveIndex(sessionId: string, index: ArtifactIndex): void {
  const dir = artifactsDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath(sessionId), JSON.stringify(index, null, 2));
}

function generateId(): string {
  return `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createArtifact(sessionId: string, opts: { title: string; html: string; dimensions?: [number, number]; filePath?: string }): Artifact {
  const id = generateId();
  const now = Date.now();
  const artifact: Artifact = {
    id,
    sessionId,
    title: opts.title,
    dimensions: opts.dimensions ?? [1080, 1080],
    version: 1,
    createdAt: now,
    updatedAt: now,
    filePath: opts.filePath,
  };

  const dir = artifactsDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(htmlPath(sessionId, id), opts.html, 'utf-8');

  const index = loadIndex(sessionId);
  index.artifacts.push(artifact);
  saveIndex(sessionId, index);

  console.log(PREFIX, `created ${id} "${opts.title}" [${artifact.dimensions.join('x')}]`);
  return artifact;
}

export function updateArtifact(sessionId: string, id: string, opts: { html?: string; title?: string; dimensions?: [number, number] }): Artifact | null {
  const index = loadIndex(sessionId);
  const artifact = index.artifacts.find(a => a.id === id);
  if (!artifact) return null;

  if (opts.html) writeFileSync(htmlPath(sessionId, id), opts.html, 'utf-8');
  if (opts.title) artifact.title = opts.title;
  if (opts.dimensions) artifact.dimensions = opts.dimensions;
  artifact.version++;
  artifact.updatedAt = Date.now();

  saveIndex(sessionId, index);
  console.log(PREFIX, `updated ${id} v${artifact.version}`);
  return artifact;
}

export function getArtifact(sessionId: string, id: string): { meta: Artifact; html: string } | null {
  const index = loadIndex(sessionId);
  const meta = index.artifacts.find(a => a.id === id);
  if (!meta) return null;
  const hp = htmlPath(sessionId, id);
  if (!existsSync(hp)) return null;
  return { meta, html: readFileSync(hp, 'utf-8') };
}

export function listArtifacts(sessionId: string): Artifact[] {
  return loadIndex(sessionId).artifacts;
}

export function findByFilePath(sessionId: string, filePath: string): Artifact | null {
  return loadIndex(sessionId).artifacts.find(a => a.filePath === filePath) ?? null;
}

export function getArtifactHtml(sessionId: string, id: string): string | null {
  const hp = htmlPath(sessionId, id);
  if (!existsSync(hp)) return null;
  return readFileSync(hp, 'utf-8');
}
