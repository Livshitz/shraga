// Reaching a human, transport-agnostically. Resolve the deployment's owners from the contacts
// store and publish a "deploy notice" on the event bus; the Slack feature subscribes and DMs each
// one. Callers stay free of Slack (and of owner-resolution) entirely.
//
// This lives on its own because more than one subsystem needs it — data-sync's merge/integrity
// alerts and self-upgrade's outcome report — and the second one silently had NO delivery at all:
// it emitted an event nobody subscribed to, so a finished upgrade never reached anyone.
import { hostname } from 'node:os';
import { emitEvent } from './events/bus.ts';

export type Owner = { name?: string; slackId: string };

/** The OWNERS env list, lowercased. THE definition of "an owner of this deployment" — every
 *  medium joins on it, each through whatever identity it happens to hold. */
export function ownerEmails(): string[] {
  return (process.env.OWNERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Is this email address an owner of this deployment?
 *
 *  Exported because a medium that is not Slack cannot use `resolveOwners`: that returns Slack ids
 *  (OWNERS ∩ contacts WITH a Slack id), which is a Slack-shaped answer. The para lane holds a
 *  shraga uid + the email of the API key that opened the link, so it joins on the email instead.
 *  An empty/unknown address is NOT an owner — the fail-closed direction, since the alternative is
 *  fanning a deploy report out to whoever happened to link a para. */
export function isOwnerEmail(email: string | undefined | null): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  return !!e && ownerEmails().includes(e);
}

/** Owners of THIS deployment (OWNERS env ∩ contacts that have a Slack id). */
export async function resolveOwners(): Promise<Owner[]> {
  const { getAll } = await import('./contacts.ts');
  return getAll()
    .filter(c => c.slackIds.length > 0 && c.emails.some(e => isOwnerEmail(e)))
    .map(c => ({ name: c.name, slackId: c.slackIds[0] }));
}

/** `APP_NAME@host` — every owner-facing alert names the instance it came from, so "is this back?"
 *  is answerable without log archaeology across hosts. */
export function senderStamp(): string {
  return `${process.env.APP_NAME || 'shraga'}@${hostname()}`;
}

/**
 * Publish an owner notice on the bus. `source` is the event-bus source (used for logging/filtering
 * only) — delivery is keyed on the notice `kind`, so a new subsystem needs no change on the Slack
 * side.
 *
 * Returns NOTHING, on purpose. It used to return "was there anyone to tell", which was a truthful
 * answer only while Slack was the sole medium: `resolveOwners` filters on a SLACK id, so once para
 * subscribes the same bus an empty owner list means "no Slack owner", not "nobody was notified".
 * Rather than keep a boolean whose meaning depends on which features happen to be registered — no
 * caller reads it (`data-sync.ts`, `self-upgrade/index.ts`) — the notice is emitted unconditionally
 * and each subscriber decides for itself. The Slack subscriber already no-ops on an empty
 * `owners`, so Slack behaviour is unchanged.
 */
export async function notifyOwners(source: string, text: string): Promise<void> {
  const owners = await resolveOwners();
  emitEvent(source as any, { kind: 'deploy', owners, text: `${text}\n\n_from ${senderStamp()}_` });
  if (!owners.length) {
    console.warn(`[${source}] No owners (OWNERS env) with Slack IDs found — notice emitted for non-Slack subscribers only`);
  }
}
