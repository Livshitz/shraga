import { useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePolicyDraft } from './RolesTab';
import { CsvInput, ErrorBox, iconBtn, inputCls, KINDS, selectCls, useAction, type Match, type OwnerCall, type Policy, type PolicyDoc } from './shared';

const KNOWN = new Set(['kind', 'id', 'emailIn', 'domain', 'verified']);

export function BindingsTab({ doc, save, call }: { doc: PolicyDoc; save: (p: Policy) => Promise<void>; call: OwnerCall }) {
  const { draft, setDraft, error, saveBar } = usePolicyDraft(doc, save);
  const roles = Object.keys(draft.roles).filter((r) => r !== 'owner');

  const update = (fn: (b: Policy['bindings']) => Policy['bindings']) => setDraft((d) => ({ ...d, bindings: fn([...d.bindings]) }));
  /** Empty values are dropped from the match (absent = "any"); unknown match keys are preserved untouched. */
  const setMatch = (i: number, key: string, v: unknown) => update((b) => {
    const m: Match = { ...b[i].match };
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete m[key]; else m[key] = v;
    b[i] = { ...b[i], match: m };
    return b;
  });
  const move = (i: number, to: number) => update((b) => { const [x] = b.splice(i, 1); b.splice(to, 0, x); return b; });

  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <p className="text-[11px] text-muted-foreground">Ordered — the first matching binding decides the role; no match → default role <b>{draft.default}</b>.</p>
      <div className="space-y-2">
        {draft.bindings.map((b, i) => {
          const extra = Object.entries(b.match).filter(([k]) => !KNOWN.has(k));
          return (
            <div key={i} className="border rounded-lg p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground w-5">#{i + 1}</span>
                <label className="text-[10px] text-muted-foreground">role</label>
                <select className={selectCls} value={b.role} onChange={(e) => update((x) => { x[i] = { ...x[i], role: e.target.value }; return x; })}>
                  {!roles.includes(b.role) && <option value={b.role}>{b.role} (invalid)</option>}
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <div className="flex-1" />
                <button className={iconBtn} title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp className="w-3.5 h-3.5" /></button>
                <button className={iconBtn} title="Move down" disabled={i === draft.bindings.length - 1} onClick={() => move(i, i + 1)}><ArrowDown className="w-3.5 h-3.5" /></button>
                <button className={`${iconBtn} hover:text-destructive`} title="Remove" onClick={() => update((x) => x.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className={selectCls} title="kind" value={b.match.kind ?? ''} onChange={(e) => setMatch(i, 'kind', e.target.value)}>
                  <option value="">any kind</option>
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <select className={selectCls} title="verified" value={b.match.verified === undefined ? '' : String(b.match.verified)} onChange={(e) => setMatch(i, 'verified', e.target.value === '' ? undefined : e.target.value === 'true')}>
                  <option value="">verified: any</option><option value="true">verified</option><option value="false">unverified</option>
                </select>
                <Input className={`${inputCls} w-40`} placeholder="domain" value={b.match.domain ?? ''} onChange={(e) => setMatch(i, 'domain', e.target.value.trim())} />
                <Input className={`${inputCls} w-48`} placeholder="id (e.g. slack:U123)" value={b.match.id ?? ''} onChange={(e) => setMatch(i, 'id', e.target.value.trim())} />
                <div className="flex-1 min-w-48"><CsvInput value={b.match.emailIn} onChange={(v) => setMatch(i, 'emailIn', v)} placeholder="emails (comma-separated)" /></div>
              </div>
              {extra.length > 0 && <p className="text-[10px] font-mono text-muted-foreground">also matches: {JSON.stringify(Object.fromEntries(extra))}</p>}
            </div>
          );
        })}
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!roles.length}
          onClick={() => update((b) => [...b, { match: { kind: 'user' }, role: roles.includes('guest') ? 'guest' : roles[roles.length - 1] }])}>
          <Plus className="w-3 h-3 mr-1" /> Add binding
        </Button>
      </div>
      {saveBar}
      <TestPrincipal call={call} />
    </div>
  );
}

interface TestResult { principal: string; role: string; rank: number; profile: string; blocked: { reason?: string } | null }

function TestPrincipal({ call }: { call: OwnerCall }) {
  const [d, setD] = useState({ kind: 'user', email: '', id: '', verified: true, lane: '', role: '' });
  const [result, setResult] = useState<TestResult | null>(null);
  const { busy, error, run } = useAction();
  const set = (patch: Partial<typeof d>) => { setD((x) => ({ ...x, ...patch })); setResult(null); };
  const test = () => run('test', async () => {
    setResult(await call<TestResult>('/policy/test', 'POST', {
      kind: d.kind, verified: d.verified, ...(d.email ? { email: d.email } : {}), ...(d.id ? { id: d.id } : {}),
      ...(d.lane ? { lane: d.lane } : {}), ...(d.role ? { role: d.role } : {}),
    }));
  });
  return (
    <section className="border rounded-lg p-3 space-y-2 bg-muted/20">
      <h3 className="text-xs font-medium flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5" /> Test a principal <span className="text-muted-foreground font-normal">(against the SAVED policy)</span></h3>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={d.kind} onChange={(e) => set({ kind: e.target.value })}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Input className={`${inputCls} w-52`} placeholder={d.kind === 'apikey' ? 'creator email' : 'email'} value={d.email} onChange={(e) => set({ email: e.target.value.trim() })} />
        <Input className={`${inputCls} w-32`} placeholder="id (optional)" value={d.id} onChange={(e) => set({ id: e.target.value.trim() })} />
        {d.kind === 'internal' && <Input className={`${inputCls} w-28`} placeholder="lane" value={d.lane} onChange={(e) => set({ lane: e.target.value.trim() })} />}
        {d.kind === 'apikey' && <Input className={`${inputCls} w-28`} placeholder="key role cap" value={d.role} onChange={(e) => set({ role: e.target.value.trim() })} />}
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={d.verified} onChange={(e) => set({ verified: e.target.checked })} /> verified</label>
        <Button size="sm" className="h-7 text-xs" disabled={!!busy} onClick={test}>
          {busy && <Loader2 className="w-3 h-3 mr-1 animate-spin" />} Resolve
        </Button>
      </div>
      <ErrorBox error={error} />
      {result && (
        <p className="text-xs font-mono">
          {result.principal} → role <b>{result.role}</b> · rank {result.rank} · profile <b>{result.profile}</b>
          {result.blocked && <span className="text-destructive"> · BLOCKED{result.blocked.reason ? ` (${result.blocked.reason})` : ''}</span>}
        </p>
      )}
    </section>
  );
}
