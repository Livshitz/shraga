// slackFeature — the ServerFeature that mounts Slack in this app. It wires the mcp-slack-use package
// `ingress` (protocol) to the agent-glue (bot.ts) and subscribes the data-sync deploy notifier
// (event bus → owner DMs). Slack ships in this app, so index.ts registers this directly.
import type { ServerFeature, FeatureContext } from '../features.ts';
import { registerSlackIngress } from 'mcp-slack-use/src/ingress.ts';
import { subscribeEvents } from '../events/bus.ts';
import { postMessage, resolveUserMentions } from './api.ts';
import { runAgentTurn, shouldRespond, onReplied, retrySlackSession, setBroadcast } from './bot.ts';
import { handleSlackInteraction } from './questions.ts';
import { registerSlackOAuthRoutes } from './oauth.ts';
import type { SessionMeta } from '../sessions.ts';

interface DeployNotice { kind: 'deploy'; owners: { name?: string; slackId: string }[]; text: string }

// mountFeatures can run twice in the passive→active promotion path; guard the once-only wiring.
let oauthMounted = false;
let ingressMounted = false;
let busSubscribed = false;

export const slackFeature: ServerFeature = {
  name: 'slack',

  register(ctx: FeatureContext): void {
    setBroadcast(ctx.broadcast);

    if (!oauthMounted) { oauthMounted = true; registerSlackOAuthRoutes(ctx.app); }

    // Data-sync deploy notices arrive on the event bus (data-sync.ts has no Slack coupling); DM owners.
    if (!ctx.passive && !busSubscribed) {
      busSubscribed = true;
      subscribeEvents((evt) => {
        if (evt.source !== 'data-sync') return;
        const payload = evt.payload as DeployNotice;
        if (payload?.kind !== 'deploy' || !payload.owners?.length) return;
        for (const owner of payload.owners) {
          postMessage(owner.slackId, payload.text)
            .then(() => console.log(`[slack] Notified ${owner.name ?? owner.slackId} via Slack DM`))
            .catch((err) => console.warn(`[slack] Deploy DM to ${owner.name ?? owner.slackId} failed:`, (err as Error).message));
        }
      });
    }

    if (ctx.passive || !process.env.SLACK_SIGNING_SECRET || ingressMounted) return;
    ingressMounted = true;
    registerSlackIngress(ctx.app as any, {
      shouldRespond,
      onMessage: runAgentTurn,
      onReplied,
      // ingress expects a void-returning handler; handleSlackInteraction's boolean is
      // unobserved here, so await it and discard — same execution, no behavior change.
      onInteraction: async (p: any) => { await handleSlackInteraction(p); },
      finalTransform: resolveUserMentions,
    });
  },

  resumeSession(session: unknown, prompt: string): Promise<void> {
    return retrySlackSession(session as SessionMeta, prompt);
  },
};
