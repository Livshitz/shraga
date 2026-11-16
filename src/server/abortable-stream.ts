/**
 * Iterate `source`, but stop once `signal` aborts — even when the source's pending `next()` never
 * settles.
 *
 * Why: aborting an engine stream is cooperative. The SDK is handed the AbortController and is
 * expected to end the iterator, but an await stuck below it (a hung MCP call, a CLI child that never
 * exits, a permission/question handler nobody answers) leaves `next()` pending forever. The consumer
 * then never reaches its `finally`, so every in-process "is it running" record — the scheduler's
 * running map, the global session lock the upgrade preflight counts — stays set: a zombie that
 * cancel cannot clear. Racing each `next()` against the signal hands control back to the caller,
 * which gets an AbortError into its normal abort handling.
 *
 * A healthy source gets `graceMs` after the abort to wind down on its own (the SDK normally does, and
 * may still yield its final events), so the cut only lands on a source that is genuinely stuck. The
 * source is then told to stop (`return()`, fire-and-forget) but never awaited: awaiting a stuck
 * generator is exactly the hang this exists to escape.
 */
export async function* untilAborted<T>(source: AsyncIterable<T>, signal?: AbortSignal, graceMs = 5_000): AsyncGenerator<T> {
  if (!signal) { yield* source; return; }
  const it = source[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { graceTimer = setTimeout(() => reject(abortError(signal)), graceMs); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // observed via the race below; never an unhandled rejection
  let finished = false;
  try {
    while (true) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) { finished = true; return; }
      yield r.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(graceTimer);
    if (!finished) {
      Promise.resolve().then(() => it.return?.()).catch((err) => console.warn('[abortable-stream] source return() failed:', (err as Error)?.message ?? err));
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}
