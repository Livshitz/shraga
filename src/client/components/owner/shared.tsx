import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import type { OwnerCall } from '@/hooks/useOwner';

export type { OwnerCall };
export interface Profile { tools: string[]; mcps: string[]; env: string[]; outbound: boolean; readScope: 'all' | 'own' | 'none'; rate: string }
export interface Match { kind?: string; id?: string; emailIn?: string[]; domain?: string; verified?: boolean; [k: string]: unknown }
export interface Policy {
  roles: Record<string, { rank: number; profile: string }>;
  profiles: Record<string, Profile>;
  bindings: { match: Match; role: string }[];
  default: string;
  blocklist: { match: Match; until: number | null; reason?: string }[];
  tokensValidAfter: Record<string, number>;
}
export interface PolicyDoc { policy: Policy; version: string; valid: boolean }

export const KINDS = ['user', 'email', 'slack', 'apikey', 'internal', 'anonymous'];
export const selectCls = 'h-7 rounded-md border border-input bg-background px-2 text-xs';
export const inputCls = 'h-7 text-xs';
export const thCls = 'text-left font-medium text-muted-foreground px-2 py-1 whitespace-nowrap';
export const tdCls = 'px-2 py-1 align-top';
export const iconBtn = 'text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors';

export const fmtTs = (v: string | number) => new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const matchLabel = (m: Match) => Object.entries(m).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`).join(' ');

/** One action at a time, with its error kept visible (useOwner's call already logged it). */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message ?? String(e)); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

/** Server error; a policy validation error ("Invalid policy: a; b") renders as a list. */
export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  const m = /^Invalid policy: (.*)$/s.exec(error);
  return (
    <div className="text-xs text-destructive border border-destructive/40 rounded-md p-2">
      {m ? (<><p className="font-medium">Invalid policy — not saved:</p><ul className="list-disc pl-4">{m[1].split('; ').map((e, i) => <li key={i}>{e}</li>)}</ul></>) : error}
    </div>
  );
}

/** Comma-separated list input; commits on blur so typing "a, " isn't normalized away mid-edit. */
export function CsvInput({ value, onChange, placeholder }: { value: string[] | undefined; onChange: (v: string[]) => void; placeholder?: string }) {
  const joined = (value ?? []).join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  return (
    <Input className={inputCls} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.split(',').map((s) => s.trim()).filter(Boolean))} />
  );
}

/** Row actions shared by Principals and Audit. Only `user:`/`internal:` principals carry revocable tokens. */
export function principalActions(call: OwnerCall) {
  return {
    canRevoke: (id: string) => /^(user|internal):/.test(id) && id !== 'internal:agent-internal',
    revoke: async (id: string) => {
      if (!confirm(`Revoke every token issued to ${id}? They must sign in again.`)) return;
      await call('/tokens/revoke', 'POST', { principalId: id });
    },
    block: async (id: string) => {
      const reason = prompt(`Block ${id}? Reason (optional):`);
      if (reason === null) return;
      await call('/blocks', 'POST', { match: { id }, until: null, reason });
    },
  };
}
