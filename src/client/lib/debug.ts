/** Component-scoped console logger.
 *
 *  `debug`/`verbose` are development output and are GATED per component — they print only when the
 *  component's name (or `*`) appears in the comma-separated `DEBUG` localStorage key:
 *      localStorage.setItem('DEBUG', 'BackendHealth,ws')
 *  `info`/`warn`/`error` are operational and ALWAYS print. Use this instead of raw `console.*` so a
 *  noisy module can be silenced without deleting the logging that diagnoses a live incident.
 */

type LogFn = (...args: unknown[]) => void;

export interface ComponentLogger {
  debug: LogFn;
  verbose: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** Read once per call rather than caching: a dev flipping `DEBUG` in devtools expects it to take
 *  effect without a reload, and this only runs on a log call that is already about to hit console. */
function gateAllows(component: string): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem('DEBUG');
  } catch {
    return false; // storage blocked (private mode / sandboxed iframe) — dev output is not worth throwing over
  }
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .some((s) => s === '*' || s === component);
}

export const logger = {
  forComponent(component: string): ComponentLogger {
    const tag = `[${component}]`;
    const gated = (fn: LogFn): LogFn => (...args) => { if (gateAllows(component)) fn(tag, ...args); };
    return {
      debug: gated((...a) => console.debug(...a)),
      verbose: gated((...a) => console.debug(...a)),
      info: (...a) => console.info(tag, ...a),
      warn: (...a) => console.warn(tag, ...a),
      error: (...a) => console.error(tag, ...a),
    };
  },
};
