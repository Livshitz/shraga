/**
 * Shraga deployment config — org-specific, lives in data/shraga.config.ts (gitignored).
 *
 * Global MCP servers are declared here — they apply to all users (read-only in UI).
 * Users can add their own MCPs via the UI (stored per-user in mcps/{uid}.json).
 *
 * Two entry styles:
 *   - Shorthand (vendor dir): { env: ['KEY1'] } → auto-resolves vendor/{name}/src/mcp/cli.ts
 *   - Full: { command: 'bunx', args: ['@stripe/mcp'], env: { STRIPE_KEY: '' } }
 *
 * Env values resolve from process.env at startup (via .env or system env).
 */
import { defineConfig } from '../src/server/shraga-config.ts';

// Agent settings (model, engine, thinking, effort, etc.) live in agent-config.json — UI-editable and the single source of truth.
export default defineConfig({
  mcps: {
    // Shorthand — vendor dir convention (vendor/mcp-example/src/mcp/cli.ts):
    // 'mcp-example': {
    //   env: ['EXAMPLE_API_KEY', 'EXAMPLE_MODE'],
    // },

    // Full — explicit command/args:
    // 'mixpanel': {
    //   command: 'bunx',
    //   args: ['mcp-remote', 'https://mcp.mixpanel.com/mcp', '--allow-http'],
    // },
  },
});
