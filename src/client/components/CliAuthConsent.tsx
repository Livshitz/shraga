import { useState } from 'react';
import { Terminal, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';

/**
 * CLI auth consent — rendered when the SPA is loaded at /cli-auth (opened by `shraga term`/`shraga
 * login`). The user is already authenticated by the app's auth layer; here they approve a terminal
 * on a specific machine. Approve mints a scoped API key (owned by THIS user) via the normal
 * /api/api-keys endpoint and hands it back to the CLI's loopback listener — so CLI-spawned terminals
 * appear in the web UI under the user's own identity. No secret is ever shown or copied by hand.
 */
export function CliAuthConsent({ getToken, userEmail }: { getToken: () => Promise<string | null>; userEmail: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const params = new URLSearchParams(window.location.search);
  const port = params.get('port') || '';
  const state = params.get('state') || '';
  const host = params.get('host') || 'this machine';
  const missing = !port || !state;

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      // Mint a key under the signed-in user (existing endpoint) — this is what ties CLI terminals to you.
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: `shraga term @ ${host}` }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const { key } = (await res.json()) as { key: string };
      // Hand the key to the CLI's loopback listener (127.0.0.1:<port>). CORS-preflighted POST.
      const cb = await fetch(`http://127.0.0.1:${port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: key, state }),
      });
      if (!cb.ok) throw new Error('Could not reach the CLI on this machine — is `shraga term` still waiting?');
      setDone(true);
    } catch (e: any) {
      setError(e.message || 'Authorization failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 p-8 rounded-xl border bg-card shadow-sm w-full max-w-sm text-center">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-11 h-11 rounded-full bg-primary text-primary-foreground">
            <Terminal className="w-5 h-5" />
          </div>
          <ShieldCheck className="w-5 h-5 text-muted-foreground" />
        </div>

        {done ? (
          <>
            <h1 className="text-lg font-semibold">Terminal authorized</h1>
            <p className="text-sm text-muted-foreground">
              Your terminal on <span className="font-medium text-foreground">{host}</span> is connected. You can close
              this tab and return to it.
            </p>
          </>
        ) : (
          <>
            <div>
              <h1 className="text-lg font-semibold">Authorize terminal</h1>
              <p className="text-sm text-muted-foreground mt-1">
                A terminal on <span className="font-medium text-foreground">{host}</span> wants to spawn and view shells
                as you. Its terminals will show up here in the web UI.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">Signed in as {userEmail}</p>
            {missing && <p className="text-sm text-destructive">Invalid request — missing parameters.</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2 w-full">
              <Button variant="outline" className="flex-1" onClick={() => window.close()} disabled={busy}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={approve} disabled={busy || missing}>
                {busy ? 'Authorizing…' : 'Authorize'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
