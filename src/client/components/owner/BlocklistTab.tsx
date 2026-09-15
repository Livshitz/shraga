import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBox, fmtTs, iconBtn, inputCls, matchLabel, selectCls, tdCls, thCls, useAction, type Match, type OwnerCall } from './shared';

interface Blocks {
  manual: { index: number; match: Match; until: number | null; reason?: string }[];
  auto: { key: string; until: number; reason: string; at: number }[];
}
const TTL: [string, number][] = [['permanent', 0], ['1 hour', 3600], ['24 hours', 86_400], ['7 days', 604_800], ['30 days', 2_592_000]];

export function BlocklistTab({ call, onPolicyChange }: { call: OwnerCall; onPolicyChange: () => Promise<void> }) {
  const [blocks, setBlocks] = useState<Blocks | null>(null);
  const [form, setForm] = useState({ field: 'id', value: '', ttl: 0, reason: '' });
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setBlocks(await call<Blocks>('/blocks')), [call]);
  useEffect(() => { run('load', load); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => run('add', async () => {
    const v = form.value.trim();
    const match: Match = form.field === 'emailIn' ? { emailIn: [v] } : { [form.field]: v };
    await call('/blocks', 'POST', { match, until: form.ttl ? Math.floor(Date.now() / 1000) + form.ttl : null, reason: form.reason });
    setForm({ ...form, value: '', reason: '' });
    await Promise.all([load(), onPolicyChange()]);
  });
  const remove = (body: object) => run('rm', async () => { await call('/blocks', 'DELETE', body); await Promise.all([load(), onPolicyChange()]); });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value })}>
          <option value="id">principal id</option><option value="emailIn">email</option><option value="domain">domain</option>
        </select>
        <Input className={`${inputCls} w-56`} placeholder={form.field === 'id' ? 'user:x@y.com / slack:U123' : form.field === 'domain' ? 'spam.tld' : 'x@y.com'} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <select className={selectCls} value={form.ttl} onChange={(e) => setForm({ ...form, ttl: Number(e.target.value) })}>
          {TTL.map(([l, s]) => <option key={s} value={s}>{l}</option>)}
        </select>
        <Input className={`${inputCls} w-40`} placeholder="reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <Button size="sm" className="h-7 text-xs" disabled={!!busy || !form.value.trim()} onClick={add}>
          {busy === 'add' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />} Block
        </Button>
        <button className={iconBtn} title="Refresh" onClick={() => run('load', load)}><RefreshCw className={`w-3.5 h-3.5 ${busy === 'load' ? 'animate-spin' : ''}`} /></button>
      </div>
      <ErrorBox error={error} />

      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Manual (policy)</h3>
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40"><tr><th className={thCls}>Match</th><th className={thCls}>Until</th><th className={thCls}>Reason</th><th className={thCls} /></tr></thead>
            <tbody className="divide-y">
              {blocks?.manual.map((b) => {
                const expired = b.until !== null && b.until * 1000 <= Date.now();
                return (
                  <tr key={b.index} className={expired ? 'opacity-50' : ''}>
                    <td className={`${tdCls} font-mono break-all`}>{matchLabel(b.match)}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{b.until === null ? 'permanent' : `${fmtTs(b.until * 1000)}${expired ? ' (expired)' : ''}`}</td>
                    <td className={tdCls}>{b.reason || '—'}</td>
                    <td className={`${tdCls} text-right`}>
                      <button className={`${iconBtn} hover:text-destructive`} title="Remove" disabled={!!busy} onClick={() => remove({ source: 'manual', index: b.index, match: b.match })}><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                );
              })}
              {blocks && !blocks.manual.length && <tr><td colSpan={4} className="text-center text-muted-foreground py-4">No manual blocks.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Automatic (guard)</h3>
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40"><tr><th className={thCls}>Key</th><th className={thCls}>Since</th><th className={thCls}>Until</th><th className={thCls}>Reason</th><th className={thCls} /></tr></thead>
            <tbody className="divide-y">
              {blocks?.auto.map((b) => (
                <tr key={b.key}>
                  <td className={`${tdCls} font-mono break-all`}>{b.key}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{fmtTs(b.at)}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{fmtTs(b.until)}</td>
                  <td className={tdCls}>{b.reason}</td>
                  <td className={`${tdCls} text-right`}>
                    <button className={`${iconBtn} hover:text-destructive`} title="Clear" disabled={!!busy} onClick={() => remove({ source: 'auto', key: b.key })}><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {blocks && !blocks.auto.length && <tr><td colSpan={5} className="text-center text-muted-foreground py-4">No active auto-blocks.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
