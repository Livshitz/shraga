import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { api } from '@/lib/api';

interface AccountStatus { connected: boolean; account: string | null; subscriptionType: string | null }
interface Accounts { me: AccountStatus | null; global?: AccountStatus }
type Target = 'me' | 'global';

/** Connect / replace / disconnect a Claude Code subscription login from the browser (no SSH). */
export function ClaudeAccountSection({ getToken }: { getToken: () => Promise<string | null> }) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [pending, setPending] = useState<{ target: Target; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Accounts>('/api/claude-account', getToken)
      .then(setAccounts)
      .catch((err: Error) => { console.warn('[ClaudeAccountSection] status failed', err); setError(err.message); });
  }, [getToken]);
  useEffect(refresh, [refresh]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const connect = (target: Target) => act(async () => {
    // Open the tab synchronously (popup blockers), then point it at the URL once the server has it.
    const tab = window.open('about:blank', '_blank');
    try {
      const { url } = await api<{ url: string }>(`/api/claude-account/${target}/login`, getToken, { method: 'POST' });
      if (tab) tab.location.href = url;
      setPending({ target, url }); setCode('');
    } catch (err) { tab?.close(); throw err; }
  });
  const submit = () => act(async () => {
    if (!pending) return;
    await api(`/api/claude-account/${pending.target}/login/code`, getToken, { method: 'POST', body: JSON.stringify({ code }) });
    setPending(null); setCode(''); refresh();
  });
  const disconnect = (target: Target) => act(async () => {
    await api(`/api/claude-account/${target}`, getToken, { method: 'DELETE' });
    refresh();
  });

  const row = (target: Target, title: string, s: AccountStatus | null) => (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="text-sm min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground truncate">
          {s?.connected ? `${s.account ?? 'Connected'}${s.subscriptionType ? ` · ${s.subscriptionType}` : ''}` : target === 'me' ? 'Not connected — using the shared subscription' : 'Not connected'}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => connect(target)}>{s?.connected ? 'Replace' : 'Connect'}</Button>
        {target === 'me' && s?.connected && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => disconnect(target)}>Use shared</Button>
        )}
      </div>
    </div>
  );

  if (!accounts) return error ? <p className="text-xs text-destructive">{error}</p> : null;
  return (
    <div className="space-y-3">
      <label className="text-sm font-medium block">Claude subscription</label>
      {accounts.me ? row('me', 'Your subscription', accounts.me) : (
        <p className="text-xs text-muted-foreground">Personal subscription unavailable: you are not a contact on this agent.</p>
      )}
      {accounts.global && row('global', 'Shared subscription', accounts.global)}
      {pending && (
        <div className="rounded-md bg-muted/50 px-3 py-2 space-y-2 text-xs">
          <p>
            Sign in on the <a className="underline" href={pending.url} target="_blank" rel="noreferrer">Claude login page</a>, then paste the code it shows.
          </p>
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste code" />
            <Button size="sm" disabled={busy || !code.trim()} onClick={submit}>Submit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
