import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';

/**
 * Disk-persisted MCP catalog + failure-cooldown (survives restarts, TTL-stamped).
 *
 * Two concerns, one file (`.mcp-catalog.json` in DATA_DIR):
 *  - `catalog`  — discovered tool specs, keyed by the lib's config hash. Implements the sync
 *                 get/set `McpCatalogStore` shape an add-on engine's MCP mounter expects, so a cold
 *                 boot reads specs from disk instead of reconnecting every server.
 *  - `cooldown` — servers that failed/timed-out to mount, keyed by server name. Persisted so a
 *                 known-down server (e.g. mcp-mac) isn't re-probed (10s) on the first boot after a
 *                 restart. Both self-heal via TTL.
 */
interface CatalogEntry { specs: any[]; exp: number }
interface DiskState { catalog: Record<string, CatalogEntry>; cooldown: Record<string, number> }

export class FileMcpCatalog {
  private file = path.join(DATA_DIR, '.mcp-catalog.json');
  private catalog = new Map<string, CatalogEntry>();
  private cooldown = new Map<string, number>();

  constructor(private catalogTtlMs = 24 * 60 * 60_000) {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<DiskState>;
        for (const [k, v] of Object.entries(raw.catalog ?? {})) this.catalog.set(k, v);
        for (const [k, v] of Object.entries(raw.cooldown ?? {})) this.cooldown.set(k, v);
      }
    } catch (e) { console.warn('[mcp-catalog] load failed:', (e as Error).message); }
  }

  // ── McpCatalogStore (specs) ──────────────────────────────────────────────
  get(key: string): any[] | null {
    const e = this.catalog.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) { this.catalog.delete(key); return null; }
    return e.specs;
  }
  set(key: string, specs: any[]): void {
    this.catalog.set(key, { specs, exp: Date.now() + this.catalogTtlMs });
    this.flush();
  }

  // ── Failure cooldown (server name → cooldown-until) ──────────────────────
  /** Currently-cooling server names (expired entries pruned). */
  cooledServers(): Set<string> {
    const now = Date.now();
    const out = new Set<string>();
    for (const [name, until] of this.cooldown) {
      if (until > now) out.add(name);
      else this.cooldown.delete(name);
    }
    return out;
  }
  cool(name: string, untilMs: number): void { this.cooldown.set(name, untilMs); this.flush(); }
  clearCool(name: string): void { if (this.cooldown.delete(name)) this.flush(); }

  private flush(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const state: DiskState = { catalog: Object.fromEntries(this.catalog), cooldown: Object.fromEntries(this.cooldown) };
      writeFileSync(this.file, JSON.stringify(state));
    } catch (e) { console.warn('[mcp-catalog] flush failed:', (e as Error).message); }
  }
}

/** Shared singleton — used by an add-on engine's MCP mount path + its boot warm-up. */
export const fileMcpCatalog = new FileMcpCatalog();
