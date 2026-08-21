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

/** Owners of THIS deployment (OWNERS env ∩ contacts that have a Slack id). */
export async function resolveOwners(): Promise<Owner[]> {
  const { getAll } = await import('./contacts.ts');
  const ownerEmails = (process.env.OWNERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return getAll()
    .filter(c => c.slackIds.length > 0 && c.emails.some(e => ownerEmails.includes(e.toLowerCase())))
    .map(c => ({ name: c.name, slackId: c.slackIds[0] }));
}

/** `APP_NAME@host` — every owner-facing alert names the instance it came from, so "is this back?"
 *  is answerable without log archaeology across hosts. */
export function senderStamp(): string {
  return `${process.env.APP_NAME || 'shraga'}@${hostname()}`;
}

/**
 * DM the owners. `source` is the event-bus source (used for logging/filtering only) — delivery is
 * keyed on the notice `kind`, so a new subsystem needs no change on the Slack side.
 * Returns false when there was nobody to tell.
 */
export async function notifyOwners(source: string, text: string): Promise<boolean> {
  const owners = await resolveOwners();
  if (!owners.length) {
    console.warn(`[${source}] No owners (OWNERS env) with Slack IDs found, skipping notification`);
    return false;
  }
  emitEvent(source as any, { kind: 'deploy', owners, text: `${text}\n\n_from ${senderStamp()}_` });
  return true;
}
