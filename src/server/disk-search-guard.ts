/**
 * Whole-disk search guard. An agent that does not know where a file lives tends to run `find / -name x`,
 * which on a Mac walks every volume for minutes (measured 3-7 min per call on the feedox box, the bulk of
 * several "slow" video turns). Nothing it looks for lives outside the data dir, the app dir or $HOME/Projects,
 * so a search rooted at the filesystem root or the bare home dir is always a mistake. Pure, for tests.
 */
import os from 'node:os';

const home = os.homedir().replace(/\/+$/, '');
const ROOTS = new Set(['/', '~', '$HOME', '${HOME}', '/Users', '/System/Volumes/Data', '/Volumes', home, '/private', '/System']);
const isRoot = (p: string) => ROOTS.has(p.replace(/^['"]|['"]$/g, '').replace(/(.)\/+$/, '$1'));
/** Leading words that just wrap the real command. */
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout', 'gtimeout']);

/** The offending search (e.g. "find /"), or null. Splits on shell separators; does not try to be a shell parser. */
export function wholeDiskSearch(command: string): string | null {
  for (const seg of command.split(/&&|\|\||[;|\n]|\$\(|`/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    while (t.length && (WRAPPERS.has(t[0]!) || /^\w+=/.test(t[0]!) || /^\d+[smh]?$/.test(t[0]!))) t.shift();
    const [cmd, ...args] = t;
    if (!cmd) continue;
    const name = cmd.split('/').pop()!;
    if (name === 'find') {
      // GNU/BSD find: leading -H/-L/-P options, then paths, then the expression.
      const rest = args.slice(args.findIndex((a) => !/^-[HLPEXdsx]+$/.test(a)) >>> 0);
      const end = rest.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
      const paths = end === -1 ? rest : rest.slice(0, end);
      const hit = paths.find(isRoot);
      if (hit) return `find ${hit}`;
    } else if (name === 'mdfind' || name === 'locate') {
      const at = args.indexOf('-onlyin');
      if (at === -1 || isRoot(args[at + 1] ?? '/')) return name;
    } else if (['grep', 'egrep', 'rg', 'ag', 'fd', 'du'].includes(name)) {
      const recursive = name !== 'grep' && name !== 'egrep' ? true : args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
      const hit = recursive ? args.find(isRoot) : undefined;
      if (hit) return `${name} ${hit}`;
    }
  }
  return null;
}

export function wholeDiskSearchMessage(what: string, dataDir?: string): string {
  return `Blocked: \`${what}\` searches the whole disk (minutes, and nothing you need lives there). ` +
    `Search where the files are: the data dir${dataDir ? ` ${dataDir}` : ' ($UNCLAW_DATA_DIR)'} — skills in its skills/ (a skill's scripts are in skills/<skill>/scripts/), ` +
    `work files in its workspace/ — the current working directory, or ~/Projects. ` +
    `To call a vendor capability (video, images, audio), use its MCP tool instead of hunting for a script.`;
}
