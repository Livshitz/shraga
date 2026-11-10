import { listCliModels } from 'ai.libx.js/models';

/** Model used when neither directives nor config specify one. Always passed
 * explicitly to the SDK — the CLI's own default silently drifts (it picked
 * Opus 4.7), which burns rate limits and budget.
 *
 * Shared because the UI must name the SAME default the server will actually run:
 * a second literal in the client drifts out of date and makes the header report a
 * model no turn would use. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/** Default for the `cursor` engine, named here for the same reason. */
export const DEFAULT_CURSOR_MODEL = 'cursor/composer-2.5';

/** Claude Code's model picker — DERIVED from ai.libx.js's catalog (the models tagged for the CLI), so a new
 *  model shows up with an ai.libx.js bump and no edit here. One list for the engine and the client fallback. */
export function claudeCodeModels(): { value: string; label: string }[] {
  return [
    { value: '', label: `Default (${DEFAULT_MODEL})` },
    ...listCliModels('claude-code').map((m) => {
      const name = m.label.replace(/^Claude /, '');
      return { value: m.value, label: m.description ? `${name} — ${m.description}` : name };
    }),
  ];
}
