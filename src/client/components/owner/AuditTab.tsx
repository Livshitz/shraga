import { useCallback, useEffect, useState } from 'react';
import { Ban, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBox, fmtTs, iconBtn, inputCls, principalActions, selectCls, tdCls, thCls, useAction, type OwnerCall } from './shared';

interface Rec { ts: string; type: string; principal?: string; role?: string; sessionId?: string; target?: string; reason?: string; hash: string }
interface Verify { ok: boolean; lines: number; brokenAt?: { file: string; line: number; reason: string } }
const TYPES = ['auth.allow', 'auth.deny', 'role.resolve', 'turn.start', 'turn.end', 'tool.allow', 'tool.deny', 'guard.limit', 'guard.block',
  'escalate', 'policy.change', 'policy.tamper', 'key.create', 'key.revoke', 'token.revoke', 'session.delete'];
const PAGE = 100;

export function AuditTab({ call, onOpenSession, onPolicyChange, ownerIds }: { call: OwnerCall; onOpenSession: (sessionId: string) => void; onPolicyChange: () => Promise<void>; ownerIds: string[] }) {
  const [f, setF] = useState({ principal: '', type: '', from: '', to: '' });
  const [items, setItems] = useState<Rec[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [verify, setVerify] = useState<Verify | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const actions = principalActions(call, onPolicyChange, ownerIds);
  const deleteSession = (id: string) => run('del', async () => {
    await call(`/sessions/${encodeURIComponent(id)}`, 'DELETE');
    setPendingDelete(null);
    setNotice(`Deleted conversation ${id}.`);
  });

  const query = (after?: string) => {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (f.principal.trim()) q.set('principal', f.principal.trim());
    if (f.type) q.set('type', f.type);
    if (f.from) q.set('from', new Date(f.from).toISOString());
    if (f.to) q.set('to', new Date(f.to).toISOString());
    if (after) q.set('cursor', after);
    return call<{ items: Rec[]; nextCursor?: string }>(`/audit?${q}`);
  };
  const search = useCallback(() => run('load', async () => { const p = await query(); setItems(p.items); setCursor(p.nextCursor); }), [call, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => run('more', async () => { const p = await query(cursor); setItems((x) => [...x, ...p.items]); setCursor(p.nextCursor); });
  const check = () => run('verify', async () => setVerify(await call<Verify>('/audit/verify')));
  useEffect(() => { search(); check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input className={`${inputCls} w-56`} placeholder="principal (exact id)" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <select className={selectCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">all types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="text-[10px] text-muted-foreground">from</label>
        <input type="datetime-local" className={selectCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <label className="text-[10px] text-muted-foreground">to</label>
        <input type="datetime-local" className={selectCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Button size="sm" className="h-7 text-xs" disabled={!!busy} onClick={search}>
          {busy === 'load' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />} Search
        </Button>
        <div className="flex-1" />
        {verify && (
          <button onClick={check} title="Re-verify the hash chain"
            className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${verify.ok ? 'border-green-500/50 text-green-600 dark:text-green-400' : 'border-destructive text-destructive'}`}>
            {verify.ok ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            {verify.ok ? `chain verified · ${verify.lines} lines` : `chain BROKEN at ${verify.brokenAt?.file}:${verify.brokenAt?.line} (${verify.brokenAt?.reason})`}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {pendingDelete && (
        <div role="alertdialog" className="flex flex-wrap items-center gap-2 text-xs border border-destructive/50 rounded-md p-2">
          <span className="flex-1 min-w-0">Delete conversation <b className="font-mono break-all">{pendingDelete}</b>? Its messages and uploads are removed for everyone; audit records stay.</span>
          <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={!!busy} onClick={() => deleteSession(pendingDelete)}>
            {busy === 'del' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />} Delete conversation
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!!busy} onClick={() => setPendingDelete(null)}>Cancel</Button>
        </div>
      )}
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40"><tr>
            <th className={thCls}>Time</th><th className={thCls}>Type</th><th className={thCls}>Principal</th><th className={thCls}>Role</th>
            <th className={thCls}>Target / reason</th><th className={thCls} />
          </tr></thead>
          <tbody className="divide-y">
            {items.map((r) => (
              <tr key={r.hash}>
                <td className={`${tdCls} whitespace-nowrap`} title={r.ts}>{fmtTs(r.ts)}</td>
                <td className={`${tdCls} font-mono whitespace-nowrap ${/deny|block|tamper/.test(r.type) ? 'text-destructive' : ''}`}>{r.type}</td>
                <td className={`${tdCls} font-mono break-all`}>
                  {r.principal ? <button className="hover:underline text-left" title="Filter by this principal" onClick={() => setF({ ...f, principal: r.principal! })}>{r.principal}</button> : '—'}
                </td>
                <td className={tdCls}>{r.role ?? '—'}</td>
                <td className={`${tdCls} break-all`}>{[r.target, r.reason].filter(Boolean).join(' · ') || '—'}</td>
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  {r.sessionId && <button className={`${iconBtn} mr-2`} title="Open session" onClick={() => onOpenSession(r.sessionId!)}><ExternalLink className="w-3.5 h-3.5" /></button>}
                  {r.sessionId && r.type !== 'session.delete' && <button className={`${iconBtn} hover:text-destructive mr-2`} title="Delete conversation" disabled={!!busy} onClick={() => { setNotice(null); setPendingDelete(r.sessionId!); }}><Trash2 className="w-3.5 h-3.5" /></button>}
                  {r.principal && actions.canRevoke(r.principal) && (
                    <button className={`${iconBtn} mr-2`} title="Revoke tokens" disabled={!!busy} onClick={() => run('rv', () => actions.revoke(r.principal!))}><KeyRound className="w-3.5 h-3.5" /></button>
                  )}
                  {r.principal && actions.canBlock(r.principal) && <button className={`${iconBtn} hover:text-destructive`} title="Block principal" disabled={!!busy} onClick={() => run('bl', () => actions.block(r.principal!))}><Ban className="w-3.5 h-3.5" /></button>}
                </td>
              </tr>
            ))}
            {!items.length && busy !== 'load' && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No audit records match.</td></tr>}
          </tbody>
        </table>
      </div>
      {cursor && (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!busy} onClick={more}>
          {busy === 'more' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />} Load older
        </Button>
      )}
    </div>
  );
}
