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
