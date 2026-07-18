/**
 * Outbound Slack mention resolution — the reverse of `resolveUserMentions`.
 *
 * `resolveUserMentions` (api.ts) rewrites inbound Slack `<@U…>` tokens into the
 * human-readable display form the agent reads, e.g. `@talshriki (operator)`.
 * There was no reverse step, so when the agent pasted that display string back
 * into an outbound message, Slack posted it as literal text and nobody got
 * pinged. This closes that asymmetry: it turns the display form back into a
 * real `<@U…>` mention token using the same contacts registry that produced it.
 *
 * Handles the two display shapes the agent ever sees:
 *   "@talshriki (operator)"  ->  "<@U0731UGPPMY>"
 *   "@talshriki"             ->  "<@U0731UGPPMY>"
 *
 * Safety: only rewrites a name that maps to exactly ONE contact slackId
 * (unambiguous). Slack keywords (@channel/@here/@everyone) and already-tokenized
 * `<@U…>` mentions are left untouched.
 */
import { getAll } from '../contacts.ts';

const SLACK_KEYWORDS = new Set(['channel', 'here', 'everyone']);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rewriteSlackMentions(text: string): { text: string; changed: boolean } {
  if (!text || !text.includes('@')) return { text, changed: false };

  // Aggregate slackIds per display name to detect ambiguity (same name, two people).
  const byName = new Map<string, Set<string>>();
  for (const c of getAll()) {
    if (!c.slackIds.length) continue;
    const key = c.name?.trim();
    if (!key || SLACK_KEYWORDS.has(key.toLowerCase())) continue;
    let set = byName.get(key);
    if (!set) { set = new Set(); byName.set(key, set); }
    for (const s of c.slackIds) set.add(s);
  }

  let result = text;
  let changed = false;
  // Longest names first so a longer name is consumed before a shorter one it contains.
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const ids = byName.get(name)!;
    if (ids.size !== 1) continue; // ambiguous — leave as-is
    const token = `<@${[...ids][0]}>`;
    const n = escapeRegex(name);
    // Tagged form first: "@name (operator|owner|contact)" — highly specific.
    const tagged = new RegExp(`@${n}\\s*\\((?:operator|owner|contact)\\)`, 'g');
    if (tagged.test(result)) { result = result.replace(tagged, token); changed = true; }
    // Bare form: "@name" not followed by a word/handle char, so "@Adam" never
    // matches inside "@Adamson" or an email/handle.
    const bare = new RegExp(`@${n}(?![\\w@.\\-])`, 'g');
    if (bare.test(result)) { result = result.replace(bare, token); changed = true; }
  }
  return { text: result, changed };
}
