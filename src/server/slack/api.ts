// Slack client — the ONE agent-glue seam onto the mcp-slack-use package `client` (unified Slack
// Web API, single bot-vs-user token-resolution path). The former duplicate `slackPost` is gone:
// everything routes through the package. Only contact/mention resolution stays here — this app owns
// the contacts store, so it can't live in the vendor package.
import * as contacts from '../contacts.ts';
import { getUserProfile } from 'mcp-slack-use/src/client.ts';

export * from 'mcp-slack-use/src/client.ts';

/** Rewrite Slack `<@Uxxx>` (and bare user ids) to `@Name (operator)?`, learning contacts as it goes. */
export async function resolveUserMentions(text: string): Promise<string> {
  const { upsert, find } = contacts;
  const mentions = [...text.matchAll(/<@(U[A-Z0-9]+)>|\b(U[A-Z0-9]{8,12})\b/g)];
  if (!mentions.length) return text;
  const ids = mentions.map(m => m[1] || m[2]);
  const profiles = await Promise.all(ids.map(id => getUserProfile(id).catch(() => ({ name: null, email: null, title: null }))));
  let result = text;
  for (let i = 0; i < mentions.length; i++) {
    const { name, email, title } = profiles[i];
    const id = ids[i];
    if (name) {
      const contact = upsert({ slackId: id, email: email || undefined, name, role: title || undefined });
      const tag = contact.isOperator ? ' (operator)' : '';
      result = result.replace(mentions[i][0], `@${name}${tag}`);
    } else {
      const existing = find({ slackId: id });
      if (existing) {
        const tag = existing.isOperator ? ' (operator)' : '';
        result = result.replace(mentions[i][0], `@${existing.name}${tag}`);
      } else {
        result = result.replace(mentions[i][0], `@unknown (Slack ID: ${id})`);
        console.warn(`[slack] Could not resolve user ${id} — may be external/Slack Connect user`);
      }
    }
  }
  return result;
}
