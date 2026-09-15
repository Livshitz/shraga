import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ApiKeysTab } from './ApiKeysTab';
import { AuditTab } from './AuditTab';
import { BindingsTab } from './BindingsTab';
import { BlocklistTab } from './BlocklistTab';
import { PrincipalsTab } from './PrincipalsTab';
import { RolesTab } from './RolesTab';
import { ErrorBox, type OwnerCall, type Policy, type PolicyDoc } from './shared';

const TABS = [['roles', 'Roles & Profiles'], ['bindings', 'Bindings'], ['principals', 'Principals'], ['keys', 'API keys'], ['blocks', 'Blocklist'], ['audit', 'Audit']] as const;
type Tab = (typeof TABS)[number][0];
const TAB_KEY = 'owner-console-tab';

function storedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some(([id]) => id === t) ? (t as Tab) : 'roles';
  } catch { return 'roles'; }
}

/** Owner-only security console. Every write goes through `/api/owner/*` (validated + audited server-side). */
export function OwnerConsole({ call, onOpenSession, trigger }: { call: OwnerCall; onOpenSession: (sessionId: string) => void; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(storedTab);
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    try { setDoc(await call<PolicyDoc>('/policy')); setLoadError(null); } catch (e: any) { setLoadError(e?.message ?? String(e)); }
  }, [call]);
  useEffect(() => { if (open) loadPolicy(); }, [open, loadPolicy]);

  const savePolicy = async (policy: Policy, version: string) => {
    await call('/policy', 'PUT', { policy, version });
    await loadPolicy();
  };
  /** Unsaved Roles/Bindings edits live in the mounted tab — leaving it discards them, so ask first. */
  const [dirty, setDirty] = useState(false);
  const leaveOk = () => !dirty || confirm('You have unsaved policy edits. Discard them?');
  const selectTab = (t: Tab) => {
    if (t === tab || !leaveOk()) return;
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch (e) { console.warn('[owner] could not persist tab', e); }
  };
  const roles = doc ? Object.keys(doc.policy.roles).filter((r) => r !== 'owner') : [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (o || leaveOk()) setOpen(o); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-[95vw] sm:max-w-5xl h-[85dvh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Owner Console
            <Button variant="ghost" size="icon" className="h-6 w-6 ml-1" title="Reload policy" onClick={loadPolicy}><RefreshCw className="w-3.5 h-3.5" /></Button>
          </DialogTitle>
          <div className="flex gap-1 overflow-x-auto pt-2" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => selectTab(id)}
                className={cn('text-xs px-2.5 py-1 rounded-md whitespace-nowrap transition-colors', tab === id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <ErrorBox error={loadError} />
          {doc && !doc.valid && (
            <p className="text-xs text-destructive border border-destructive/40 rounded-md p-2">
              The policy file is invalid — the server is failing closed (owners only). Saving a valid policy restores it.
            </p>
          )}
          {(tab === 'roles' || tab === 'bindings') && !doc && !loadError && <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>}
          {tab === 'roles' && doc && <RolesTab doc={doc} save={savePolicy} onDirty={setDirty} />}
          {tab === 'bindings' && doc && <BindingsTab doc={doc} save={savePolicy} call={call} onDirty={setDirty} />}
          {tab === 'principals' && <PrincipalsTab call={call} onPolicyChange={loadPolicy} ownerIds={doc?.ownerIds ?? []} />}
          {tab === 'keys' && <ApiKeysTab call={call} roles={roles} />}
          {tab === 'blocks' && <BlocklistTab call={call} onPolicyChange={loadPolicy} />}
          {tab === 'audit' && <AuditTab call={call} onPolicyChange={loadPolicy} ownerIds={doc?.ownerIds ?? []} onOpenSession={(id) => { setOpen(false); onOpenSession(id); }} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
