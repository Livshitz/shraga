/**
 * The one-line preview on a collapsed tool pill. Shows the ARGUMENT that identifies the call — the
 * command, the path, the pattern — not the argument NAMES. Listing keys (`command, background,
 * description`) made every Bash pill identical, so a real operation (dispatching a worker, running a
 * build) was indistinguishable from any other and read as "no tool calls shown at all".
 * Order is by how well a field identifies the call; anything unrecognised falls back to the first
 * usable string value, then to the key list.
 */
const PREVIEW_KEYS = ['command', 'pattern', 'glob_pattern', 'file_path', 'path', 'url', 'query', 'prompt', 'id', 'description', 'name', 'text'];

export function toolPreview(input: unknown, max = 120): string {
  if (typeof input === 'string') return oneLine(input, max);
  if (typeof input !== 'object' || input === null) return String(input).slice(0, max);
  const obj = input as Record<string, unknown>;
  for (const k of PREVIEW_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return oneLine(v, max);
  }
  const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim());
  if (typeof first === 'string') return oneLine(first, max);
  return Object.keys(obj).join(', ');
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

