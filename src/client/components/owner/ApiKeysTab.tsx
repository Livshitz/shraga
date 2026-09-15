import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBox, fmtTs, iconBtn, inputCls, selectCls, tdCls, thCls, useAction, type OwnerCall } from './shared';

interface Key { id: string; keyPreview: string; label: string; email: string; createdAt: number; role?: string; expiresAt?: number }
const EXPIRY: [string, number][] = [['never', 0], ['1 day', 1], ['7 days', 7], ['30 days', 30], ['90 days', 90]];

export function ApiKeysTab({ call, roles }: { call: OwnerCall; roles: string[] }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [form, setForm] = useState({ label: '', role: '', days: 0 });
  const [created, setCreated] = useState<{ key: string; label: string } | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setKeys((await call<{ keys: Key[] }>('/api-keys')).keys), [call]);
  useEffect(() => { run('load', load); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = () => run('create', async () => {
    const k = await call<{ key: string; label: string }>('/api-keys', 'POST', {
      label: form.label || 'Unnamed', ...(form.role ? { role: form.role } : {}),
      ...(form.days ? { expiresAt: Date.now() + form.days * 86_400_000 } : {}),
    });
    setCreated(k);
    setForm({ label: '', role: '', days: 0 });
    await load();
  });
  const copy = (text: string) => navigator.clipboard.writeText(text).catch((e) => console.warn('[owner] clipboard write failed', e));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className={`${inputCls} w-48`} placeholder="label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <select className={selectCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} title="Role cap (never above the creator)">
          <option value="">role: creator's (uncapped)</option>
          {roles.map((r) => <option key={r} value={r}>role cap: {r}</option>)}
        </select>
        <select className={selectCls} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>
          {EXPIRY.map(([l, d]) => <option key={d} value={d}>expires: {l}</option>)}
        </select>
        <Button size="sm" className="h-7 text-xs" disabled={!!busy} onClick={create}>
          {busy === 'create' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />} Create key
        </Button>
      </div>
      {created && (
        <div className="border border-amber-500/50 bg-amber-500/10 rounded-lg p-2 space-y-1">
          <p className="text-xs font-medium">Key "{created.label}" — copy it now, it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono break-all flex-1 select-all">{created.key}</code>
            <button className={iconBtn} title="Copy" onClick={() => copy(created.key)}><Copy className="w-3.5 h-3.5" /></button>
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setCreated(null)}>Done</Button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40"><tr>
            <th className={thCls}>Label</th><th className={thCls}>Key</th><th className={thCls}>Creator</th><th className={thCls}>Role</th>
            <th className={thCls}>Created</th><th className={thCls}>Expires</th><th className={thCls} />
          </tr></thead>
          <tbody className="divide-y">
            {keys?.map((k) => {
              const expired = k.expiresAt !== undefined && k.expiresAt <= Date.now();
              return (
                <tr key={k.id} className={expired ? 'opacity-50' : ''}>
                  <td className={tdCls}>{k.label}</td>
                  <td className={`${tdCls} font-mono`}>{k.keyPreview}</td>
                  <td className={tdCls}>{k.email}</td>
                  <td className={tdCls}>{k.role ?? <span className="text-muted-foreground">creator's</span>}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{fmtTs(k.createdAt)}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{k.expiresAt ? `${fmtTs(k.expiresAt)}${expired ? ' (expired)' : ''}` : 'never'}</td>
                  <td className={`${tdCls} text-right`}>
                    <button className={`${iconBtn} hover:text-destructive`} title="Revoke" disabled={!!busy}
                      onClick={() => { if (confirm(`Revoke key "${k.label}" (${k.keyPreview})?`)) run(`rm-${k.id}`, async () => { await call(`/api-keys/${k.id}`, 'DELETE'); await load(); }); }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {keys && !keys.length && <tr><td colSpan={7} className="text-center text-muted-foreground py-6">No API keys.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
