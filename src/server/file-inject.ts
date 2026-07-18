import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface InjectFileOptions {
  maxChars?: number;
  label?: string;
  /** Transform raw content before truncation. 'conversation' extracts text-only blocks from JSONL. */
  transform?: 'conversation' | ((content: string) => string);
}

function transformConversation(raw: string): string {
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try {
      const msg = JSON.parse(line);
      if (!msg.blocks || !msg.role) return [];
      return msg.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => `[${msg.role}]: ${b.text}`);
    } catch { return []; }
  }).join('\n');
}

export function injectFile(filePath: string, opts?: InjectFileOptions): string {
  if (!existsSync(filePath)) return '';
  const label = opts?.label ?? 'file';
  const maxChars = opts?.maxChars ?? 2000;
  const unlimited = maxChars <= 0;
  const name = path.basename(filePath);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8').trim();
  } catch (e) {
    console.warn(`[file-inject] Failed to read ${filePath}:`, e);
    return '';
  }
  if (!content) return '';
  if (opts?.transform === 'conversation') content = transformConversation(content);
  else if (typeof opts?.transform === 'function') content = opts.transform(content);
  if (!content) return '';
  const truncated = !unlimited && content.length > maxChars;
  const body = truncated
    ? `${content.slice(0, maxChars)}\n… (truncated at ${maxChars} chars — full file: ${filePath})`
    : content;
  return `<${label} path="${filePath}">\n# ${name}\n${body}\n</${label}>`;
}
