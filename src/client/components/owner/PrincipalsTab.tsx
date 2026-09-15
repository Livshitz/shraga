import { useCallback, useEffect, useState } from 'react';
import { Ban, KeyRound, RefreshCw } from 'lucide-react';
import { ErrorBox, fmtTs, iconBtn, principalActions, selectCls, tdCls, thCls, useAction, type OwnerCall } from './shared';

interface Row { id: string; kind: string; lastRole?: string; lastSeen: string; turns: number; denies: number }

export function PrincipalsTab({ call, onPolicyChange, ownerIds }: { call: OwnerCall; onPolicyChange: () => Promise<void>; ownerIds: string[] }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<{ principals: Row[]; truncated: boolean } | null>(null);
  const { busy, error, run } = useAction();
  const actions = principalActions(call, onPolicyChange, ownerIds);
  const load = useCallback(() => run('load', async () => setData(await call(`/principals?days=${days}`))), [call, days]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Seen in the audit, last</span>
        <select className={selectCls} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
        </select>
        <button className={iconBtn} title="Refresh" onClick={load}><RefreshCw className={`w-3.5 h-3.5 ${busy === 'load' ? 'animate-spin' : ''}`} /></button>
        {data?.truncated && <span className="text-[10px] text-amber-500">scan capped — older activity omitted</span>}
      </div>
      <ErrorBox error={error} />
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40"><tr>
            <th className={thCls}>Principal</th><th className={thCls}>Kind</th><th className={thCls}>Last role</th>
            <th className={thCls}>Last seen</th><th className={thCls}>Turns</th><th className={thCls} title="Includes shadow (would-deny) verdicts">Denies</th><th className={thCls} />
          </tr></thead>
          <tbody className="divide-y">
            {data?.principals.map((p) => (
              <tr key={p.id}>
                <td className={`${tdCls} font-mono break-all`}>{p.id}</td>
                <td className={tdCls}>{p.kind}</td>
                <td className={tdCls}>{p.lastRole ?? '—'}</td>
                <td className={`${tdCls} whitespace-nowrap`}>{fmtTs(p.lastSeen)}</td>
                <td className={tdCls}>{p.turns}</td>
                <td className={`${tdCls} ${p.denies ? 'text-destructive' : ''}`}>{p.denies}</td>
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  {actions.canRevoke(p.id) && (
                    <button className={`${iconBtn} mr-2`} title="Revoke tokens" disabled={!!busy} onClick={() => run(`rv-${p.id}`, () => actions.revoke(p.id))}><KeyRound className="w-3.5 h-3.5" /></button>
                  )}
                  {actions.canBlock(p.id) &&<button className={`${iconBtn} hover:text-destructive`} title="Block" disabled={!!busy} onClick={() => run(`bl-${p.id}`, () => actions.block(p.id))}><Ban className="w-3.5 h-3.5" /></button>}
                </td>
              </tr>
            ))}
            {data && !data.principals.length && <tr><td colSpan={7} className="text-center text-muted-foreground py-6">No principals in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
