export interface SlashCommand {
  command: string;
  args: string;
}

const SLASH_RE = /^\/(\w[\w-]*)(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(text: string): SlashCommand | null {
  const m = text.match(SLASH_RE);
  if (!m) return null;
  return { command: m[1], args: (m[2] ?? '').trim() };
}

export function formatCommandBlock(name: string, content: string, args: string): string {
  const body = content.includes('$ARGUMENTS')
    ? content.replace(/\$ARGUMENTS/g, args || '')
    : args
      ? `${content}\n\nARGUMENTS: ${args}`
      : content;
  return `<command name="${name}">\n${body}\n</command>`;
}
