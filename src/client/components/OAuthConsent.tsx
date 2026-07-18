import { useState } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';

/**
 * OAuth consent screen for the embedded MCP Authorization Server.
 * Rendered when the SPA is loaded at /oauth/authorize (claude.ai's authorization redirect).
 * The user is already authenticated by the app's auth layer (provider-agnostic) — here they
 * just approve the connection, which mints an auth code server-side and redirects back.
 */
export function OAuthConsent({ getToken, userEmail }: { getToken: () => Promise<string | null>; userEmail: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  const codeChallenge = params.get('code_challenge') || '';
  const codeChallengeMethod = params.get('code_challenge_method') || 'S256';
  const resource = params.get('resource') || '';
  const clientName = params.get('client_name') || 'An MCP client';

  const missing = !clientId || !redirectUri || !codeChallenge;

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch('/oauth/authorize/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          resource,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error_description || data.error || `Request failed (${res.status})`);
      }
      const { code } = await res.json();
      const url = new URL(redirectUri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      window.location.href = url.toString();
    } catch (e: any) {
      setError(e.message || 'Authorization failed');
      setBusy(false);
    }
  }

  function deny() {
    if (!redirectUri) return;
    try {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      window.location.href = url.toString();
    } catch { /* invalid redirect — nothing to navigate to */ }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 p-8 rounded-xl border bg-card shadow-sm w-full max-w-sm">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-11 h-11 rounded-full bg-primary text-primary-foreground">
            <Bot className="w-5 h-5" />
          </div>
          <ShieldCheck className="w-5 h-5 text-muted-foreground" />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold">Authorize connection</h1>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-medium text-foreground">{clientName}</span> wants to connect to your Shraga agent and
            access it on your behalf.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">Signed in as {userEmail}</p>

        {missing && (
          <p className="text-sm text-destructive text-center">Invalid authorization request — missing parameters.</p>
        )}
        {error && <p className="text-sm text-destructive text-center">{error}</p>}

        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1" onClick={deny} disabled={busy}>
            Deny
          </Button>
          <Button className="flex-1" onClick={approve} disabled={busy || missing}>
            {busy ? 'Authorizing…' : 'Approve'}
          </Button>
        </div>
      </div>
    </div>
  );
}
