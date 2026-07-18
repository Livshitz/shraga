/** A single event flowing through the bus. `source` routes it to matching
 *  `event`-trigger schedules; `payload` is matched against their `match` filter and
 *  injected into the run. `id` (optional) dedupes retried webhook deliveries. */
export interface ShragaEvent<K extends string = string> {
  source: K;
  payload: PayloadOf<K>;
  id?: string;
  at: number;
}

/** Extensible registry of source → payload types. Add-ons augment it via
 *  declaration merging so a known source gets a typed payload, e.g.:
 *
 *    declare module '../events/types.ts' {
 *      interface ShragaEventMap { stripe: Stripe.Event }
 *    }
 *
 *  Sources NOT in the map still work — they fall back to `unknown` (see PayloadOf),
 *  so untyped/ad-hoc emitters keep compiling. */
export interface ShragaEventMap {
  // Core sources shipped by shraga itself. Add-ons merge in their own.
  'schedule.finished': {
    scheduleId: string;
    name?: string;
    status?: string;
    sessionId?: string;
    error?: string;
  };
}

/** Payload type for a source: the mapped type if registered, else `unknown`. */
export type PayloadOf<K extends string> = K extends keyof ShragaEventMap ? ShragaEventMap[K] : unknown;
