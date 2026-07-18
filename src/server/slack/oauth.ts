import type { Express } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { requireAuth } from '../auth.ts';
import { dataPath } from '../paths.ts';

const TOKENS_FILE = 'slack-tokens.json';
const TOKENS_PATH = () => dataPath(TOKENS_FILE);

interface SlackTokens {
  botToken?: string;
  userToken?: string;
  authedUser?: { id: string; scope: string };
  updatedAt?: string;
}

function loadTokens(): SlackTokens {
  const p = TOKENS_PATH();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`[slack-oauth] Failed to parse ${TOKENS_FILE}:`, e); return {}; }
}

function saveTokens(tokens: SlackTokens) {
  writeFileSync(TOKENS_PATH(), JSON.stringify(tokens, null, 2));
}

function getBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}

/** Load file-based tokens into process.env if not already set. */
export function hydrateSlackTokens() {
  const tokens = loadTokens();
  if (!process.env.SLACK_USER_TOKEN && tokens.userToken) {
    process.env.SLACK_USER_TOKEN = tokens.userToken;
    console.log(`[slack-oauth] Hydrated SLACK_USER_TOKEN from ${TOKENS_FILE} (user=${tokens.authedUser?.id})`);
  }
  if (!process.env.SLACK_BOT_TOKEN && tokens.botToken) {
    process.env.SLACK_BOT_TOKEN = tokens.botToken;
    console.log(`[slack-oauth] Hydrated SLACK_BOT_TOKEN from ${TOKENS_FILE}`);
  }
}
/** @deprecated Use hydrateSlackTokens */
export const hydrateSlackUserToken = hydrateSlackTokens;

export function registerSlackOAuthRoutes(app: Express) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;

  const USER_SCOPES = 'search:read,chat:write,groups:read,im:history,im:read,im:write,links:read,links:write,users:read,users:read.email,users:write,reactions:write,reactions:read';

  app.get('/api/slack/oauth/start', (req, res) => {
    const redirectUri = `${getBaseUrl(req)}/api/slack/oauth/callback`;
    const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${encodeURIComponent(USER_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(url);
  });

  app.get('/api/slack/oauth/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || typeof code !== 'string') return res.status(400).send('Missing code');

    const redirectUri = `${getBaseUrl(req)}/api/slack/oauth/callback`;
    try {
      const resp = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
      });
      const data = await resp.json() as any;
      if (!data.ok) return res.status(400).send(`Slack error: ${data.error}`);

      const tokens = loadTokens();
      if (data.authed_user?.access_token) {
        tokens.userToken = data.authed_user.access_token;
        tokens.authedUser = { id: data.authed_user.id, scope: data.authed_user.scope };
        process.env.SLACK_USER_TOKEN = tokens.userToken;
      }
      if (data.access_token) tokens.botToken = data.access_token;
      tokens.updatedAt = new Date().toISOString();
      saveTokens(tokens);

      console.log(`[slack-oauth] Token exchange success — user=${data.authed_user?.id}, scopes=${data.authed_user?.scope}`);
      res.send(`<h2>Slack OAuth complete</h2><p>User token saved for ${data.authed_user?.id || 'bot'}.</p><p>You can close this tab.</p>`);
    } catch (e: any) {
      console.error('[slack-oauth] Token exchange failed:', e.message);
      res.status(500).send(`Token exchange failed: ${e.message}`);
    }
  });

  app.get('/api/slack/oauth/status', requireAuth, (_req, res) => {
    const tokens = loadTokens();
    res.json({
      hasUserToken: !!tokens.userToken,
      hasEnvUserToken: !!process.env.SLACK_USER_TOKEN,
      authedUser: tokens.authedUser || null,
      updatedAt: tokens.updatedAt || null,
    });
  });
}
