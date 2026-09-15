import { useEffect, useState } from 'react';
import { Check, Loader2, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CsvInput, ErrorBox, iconBtn, inputCls, selectCls, useAction, type Policy, type PolicyDoc, type Profile, type SavePolicy } from './shared';

/** The part of the policy a PUT writes (blocklist/tokensValidAfter have their own routes; the server keeps them). */
const editable = (p: Policy) => { const { blocklist: _b, tokensValidAfter: _t, ...rest } = p; return JSON.stringify(rest); };

/** A whole-document policy draft: edit locally, Save = PUT with the version the draft started from (server validates;
 *  errors stay on screen). A refresh never wipes edits: a clean draft follows it; a dirty one adopts the new version only
 *  when the editable part is unchanged (a block/revoke meanwhile) — otherwise Save still 409s instead of overwriting. */
export function usePolicyDraft(doc: PolicyDoc, save: SavePolicy, onDirty?: (dirty: boolean) => void) {
  const [base, setBase] = useState(doc);
  const [draft, setDraft] = useState<Policy>(() => structuredClone(doc.policy));
  const dirty = editable(draft) !== editable(base.policy);
  useEffect(() => {
    if (!dirty || editable(doc.policy) === editable(draft)) { setBase(doc); setDraft(structuredClone(doc.policy)); }
    else if (editable(doc.policy) === editable(base.policy)) setBase(doc);
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  const action = useAction();
  const saveBar = (
    <div className="flex items-center gap-2 sticky -bottom-3 z-10 -mx-3 -mb-3 px-3 pt-2 pb-3 bg-background border-t">
      <Button size="sm" className="h-7 text-xs" disabled={!dirty || !!action.busy} onClick={() => action.run('save', () => save(draft, base.version))}>
        {action.busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Check className="w-3 h-3 mr-1" />} Save policy
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!dirty} onClick={() => { setBase(doc); setDraft(structuredClone(doc.policy)); }}>
        <Undo2 className="w-3 h-3 mr-1" /> Discard
      </Button>
      {dirty && <span className="text-[10px] text-amber-500">unsaved changes</span>}
    </div>
  );
  return { draft, setDraft, error: action.error, saveBar };
}

export function RolesTab({ doc, save, onDirty }: { doc: PolicyDoc; save: SavePolicy; onDirty: (dirty: boolean) => void }) {
  const { draft, setDraft, error, saveBar } = usePolicyDraft(doc, save, onDirty);
  const [newRole, setNewRole] = useState('');
  const [newProfile, setNewProfile] = useState('');
  const profileNames = Object.keys(draft.profiles);

  const setRole = (name: string, patch: Partial<Policy['roles'][string]>) =>
    setDraft((d) => ({ ...d, roles: { ...d.roles, [name]: { ...d.roles[name], ...patch } } }));
  const setProfile = (name: string, patch: Partial<Profile>) =>
    setDraft((d) => ({ ...d, profiles: { ...d.profiles, [name]: { ...d.profiles[name], ...patch } } }));
  const without = <T,>(o: Record<string, T>, k: string) => Object.fromEntries(Object.entries(o).filter(([n]) => n !== k));

  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Roles</h3>
        <p className="text-[11px] text-muted-foreground">Owners come only from the OWNERS env; this row only picks their rank and profile.</p>
        <div className="border rounded-lg divide-y">
          {Object.entries(draft.roles).sort((a, b) => b[1].rank - a[1].rank).map(([name, r]) => (
            <div key={name} className="flex items-center gap-2 p-2">
              <span className="text-sm font-medium w-28 truncate">{name}</span>
              <label className="text-[10px] text-muted-foreground">rank</label>
              <Input type="number" className={`${inputCls} w-20`} value={Number.isFinite(r.rank) ? r.rank : ''} onChange={(e) => setRole(name, { rank: e.target.value === '' ? NaN : Number(e.target.value) })} />
              <label className="text-[10px] text-muted-foreground">profile</label>
              <select className={selectCls} value={r.profile} onChange={(e) => setRole(name, { profile: e.target.value })}>
                {!profileNames.includes(r.profile) && <option value={r.profile}>{r.profile} (missing)</option>}
                {profileNames.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <div className="flex-1" />
              {name !== 'owner' && (
                <button className={`${iconBtn} hover:text-destructive`} title="Remove role" onClick={() => setDraft((d) => ({ ...d, roles: without(d.roles, name) }))}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input className={`${inputCls} w-40`} placeholder="new role name" value={newRole} onChange={(e) => setNewRole(e.target.value.trim())} />
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!newRole || newRole in draft.roles}
            onClick={() => { setDraft((d) => ({ ...d, roles: { ...d.roles, [newRole]: { rank: 10, profile: profileNames.includes('none') ? 'none' : profileNames[0] } } })); setNewRole(''); }}>
            <Plus className="w-3 h-3 mr-1" /> Add role
          </Button>
          <div className="flex-1" />
          <label className="text-[10px] text-muted-foreground">default role</label>
          <select className={selectCls} value={draft.default} onChange={(e) => setDraft((d) => ({ ...d, default: e.target.value }))}>
            {Object.keys(draft.roles).filter((n) => n !== 'owner').map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Profiles</h3>
        {Object.entries(draft.profiles).map(([name, p]) => (
          <div key={name} className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{name}</span>
              <div className="flex-1" />
              <button className={`${iconBtn} hover:text-destructive`} title="Remove profile" onClick={() => setDraft((d) => ({ ...d, profiles: without(d.profiles, name) }))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1.5 items-center">
              {(['tools', 'mcps', 'env'] as const).map((f) => (
                <FieldRow key={f} label={f}><CsvInput value={p[f]} onChange={(v) => setProfile(name, { [f]: v })} placeholder='comma-separated, "*" = all' /></FieldRow>
              ))}
              <FieldRow label="rate"><Input className={`${inputCls} w-28`} value={p.rate} placeholder="120/h" onChange={(e) => setProfile(name, { rate: e.target.value.trim() })} /></FieldRow>
              <FieldRow label="readScope">
                <select className={`${selectCls} w-28`} value={p.readScope} onChange={(e) => setProfile(name, { readScope: e.target.value as Profile['readScope'] })}>
                  {['all', 'own', 'none'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="outbound">
                <input type="checkbox" className="h-4 w-4 justify-self-start" checked={p.outbound} onChange={(e) => setProfile(name, { outbound: e.target.checked })} />
              </FieldRow>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Input className={`${inputCls} w-40`} placeholder="new profile name" value={newProfile} onChange={(e) => setNewProfile(e.target.value.trim())} />
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!newProfile || newProfile in draft.profiles}
            onClick={() => { setDraft((d) => ({ ...d, profiles: { ...d.profiles, [newProfile]: { tools: [], mcps: [], env: [], outbound: false, readScope: 'none', rate: '0' } } })); setNewProfile(''); }}>
            <Plus className="w-3 h-3 mr-1" /> Add profile
          </Button>
        </div>
      </section>
      {saveBar}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><label className="text-[11px] text-muted-foreground">{label}</label>{children}</>);
}
