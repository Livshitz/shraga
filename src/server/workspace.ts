import { mkdirSync, readdirSync, readFileSync, statSync, existsSync, watch } from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.ts';
import { dataSync } from './data-sync.ts';
import { injectFile } from './file-inject.ts';

export const WORKSPACE_DIR = process.env.WORKSPACE_DIR || dataPath('workspace');

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.tiff',
  '.mp4', '.webm', '.avi', '.mov', '.mkv', '.mp3', '.ogg', '.wav', '.flac', '.aac',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.sqlite3',
]);
const MAX_CONTEXT_BYTES = 5_000;
const MAX_ENTRIES = 500;

export interface WorkspaceEntry {
  path: string;              // relative to WORKSPACE_DIR, POSIX separators
  type: 'file' | 'dir';
  size?: number;
  oneLiner?: string;
}

export function ensureDir() {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
}

function isTextFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;
  if (ext) return true;
  try {
    const buf = readFileSync(p, { flag: 'r' });
    const sample = buf.subarray(0, Math.min(buf.length, 512));
    return !sample.some(b => b === 0);
  } catch { return false; }
}

export function safeResolve(relPath: string): string | null {
  const resolved = path.resolve(WORKSPACE_DIR, relPath);
  const base = path.resolve(WORKSPACE_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function firstMeaningfulLine(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '');
    if (line) return line.slice(0, 100);
  }
  return '';
}

export function listWorkspaceTree(): WorkspaceEntry[] {
  ensureDir();
  const entries: WorkspaceEntry[] = [];
  const walk = (dir: string, rel: string) => {
    if (entries.length >= MAX_ENTRIES) return;
    let items: import('node:fs').Dirent[];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ path: relPath, type: 'dir' });
        walk(full, relPath);
      } else if (item.isFile()) {
        let size = 0;
        try { size = statSync(full).size; } catch {}
        let oneLiner: string | undefined;
        if (isTextFile(full) && size < 64_000) {
          try { oneLiner = firstMeaningfulLine(readFileSync(full, 'utf-8')); } catch {}
        }
        entries.push({ path: relPath, type: 'file', size, oneLiner });
      }
      if (entries.length >= MAX_ENTRIES) return;
    }
  };
  walk(WORKSPACE_DIR, '');
  return entries;
}

export function listWorkspaceDir(relDir = ''): WorkspaceEntry[] {
  ensureDir();
  const base = relDir ? safeResolve(relDir) : WORKSPACE_DIR;
  if (!base) return [];
  let items: import('node:fs').Dirent[];
  try { items = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const entries: WorkspaceEntry[] = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const full = path.join(base, item.name);
    const relPath = relDir ? `${relDir}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push({ path: relPath, type: 'dir' });
    } else if (item.isFile()) {
      let size = 0;
      try { size = statSync(full).size; } catch {}
      let oneLiner: string | undefined;
      if (isTextFile(full) && size < 64_000) {
        try { oneLiner = firstMeaningfulLine(readFileSync(full, 'utf-8')); } catch {}
      }
      entries.push({ path: relPath, type: 'file', size, oneLiner });
    }
  }
  return entries;
}

export function listWorkspaceFilePaths(): string[] {
  return listWorkspaceTree().filter((e) => e.type === 'file').map((e) => e.path);
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export function searchWorkspace(query: string, maxResults = 50): SearchMatch[] {
  ensureDir();
  const lower = query.toLowerCase();
  const matches: SearchMatch[] = [];
  const files = listWorkspaceTree().filter(e => e.type === 'file');
  for (const entry of files) {
    if (matches.length >= maxResults) break;
    const resolved = safeResolve(entry.path);
    if (!resolved || !isTextFile(resolved)) continue;
    let content: string;
    try {
      const st = statSync(resolved);
      if (st.size > 256_000) continue;
      content = readFileSync(resolved, 'utf-8');
    } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;
      if (lines[i].toLowerCase().includes(lower)) {
        matches.push({ path: entry.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return matches;
}

export function readWorkspaceFile(relPath: string): { content: string; binary: boolean } | null {
  const resolved = safeResolve(relPath);
  if (!resolved || !existsSync(resolved)) return null;
  const st = statSync(resolved);
  if (!st.isFile()) return null;
  if (!isTextFile(resolved)) return { content: '', binary: true };
  return { content: readFileSync(resolved, 'utf-8'), binary: false };
}

export function buildWorkspaceContextBlock(): string {
  const entries = listWorkspaceTree();
  const lines: string[] = [];
  let bytes = 0;
  for (const e of entries) {
    const line = e.type === 'dir'
      ? `${e.path}/`
      : e.oneLiner
        ? `${e.path} — ${e.oneLiner}`
        : e.path;
    if (bytes + line.length + 1 > MAX_CONTEXT_BYTES) {
      lines.push('… (truncated)');
      break;
    }
    lines.push(line);
    bytes += line.length + 1;
  }
  return [
    '<workspace>',
    `This is the team's shared knowledge folder — living context: business info, ongoing tasks, research dumps, kanban lists, decisions. You are EXPECTED to read, write, edit, and reorganize files here as part of normal work. When the user mentions "the workspace", "our notes", "our tasks", "kanban", etc., they mean this folder.`,
    '',
    `LOCATION: ${WORKSPACE_DIR}`,
    `Always use this absolute path with Read/Write/Edit/Glob — NOT "/workspace" (root) and NOT a project-relative path. Example: Write { file_path: "${WORKSPACE_DIR}/tasks.md", content: "..." }.`,
    '',
    'Files explicitly @-mentioned by the user are already inlined below as <workspace-file> blocks. For anything else in the tree, read on demand.',
    '',
    entries.length === 0
      ? 'Tree: (empty — feel free to create initial files like tasks.md, context.md, research/, etc.)'
      : 'Tree (paths shown relative to workspace root):',
    ...lines.map((l) => `  ${l}`),
    '',
    injectFile(path.join(WORKSPACE_DIR, 'context.md'), { label: 'workspace-context', maxChars: 0 }),
    '</workspace>',
  ].filter(Boolean).join('\n');
}

const WORKSPACE_MENTION_RE = /@([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g;

export function expandWorkspaceMentions(text: string): string {
  const files = new Set(listWorkspaceFilePaths());
  const matched = new Set<string>();
  for (const m of text.matchAll(WORKSPACE_MENTION_RE)) {
    if (files.has(m[1])) matched.add(m[1]);
  }
  if (matched.size === 0) return text;
  const blocks: string[] = [];
  for (const rel of matched) {
    const file = readWorkspaceFile(rel);
    if (!file || file.binary) continue;
    blocks.push(`<workspace-file path="${rel}">\n${file.content}\n</workspace-file>`);
  }
  if (blocks.length === 0) return text;
  return `${blocks.join('\n')}\n\n${text}`;
}

export function watchWorkspace(cb: (event: { action: 'created' | 'modified' | 'deleted'; path: string }) => void): () => void {
  ensureDir();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, 'created' | 'modified' | 'deleted'>();
  const flush = () => {
    for (const [p, action] of pending) cb({ action, path: p });
    pending.clear();
    timer = null;
  };
  let watcher: import('node:fs').FSWatcher;
  try {
    watcher = watch(WORKSPACE_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (rel.split('/').some((seg) => seg.startsWith('.'))) return;
      const full = path.join(WORKSPACE_DIR, rel);
      const action: 'created' | 'modified' | 'deleted' = existsSync(full)
        ? (eventType === 'rename' ? 'created' : 'modified')
        : 'deleted';
      pending.set(rel, action);
      dataSync.trackWrite(`workspace/${rel}`);
      if (!timer) timer = setTimeout(flush, 300);
    });
  } catch (err) {
    console.warn('[workspace] watch failed:', (err as Error).message);
    return () => {};
  }
  return () => watcher.close();
}
