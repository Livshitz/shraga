import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
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
export interface PolicyDoc { policy: Policy; version: string; valid: boolean; ownerIds?: string[] }
/** PUT the whole policy, guarded by the version the edit started from. */
export type SavePolicy = (policy: Policy, version: string) => Promise<void>;

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

export const isEmail = (s: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

/** One chip per value — add with Enter/comma/paste (splits on , ; whitespace), × to remove. Lowercased + de-duplicated;
 *  values failing `validate` are kept but flagged red so a typo is visible instead of silently never matching. */
export function ChipInput({ value, onChange, placeholder, validate }: { value: string[] | undefined; onChange: (v: string[]) => void; placeholder?: string; validate?: (s: string) => boolean }) {
  const items = value ?? [];
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const next = [...items];
    for (const s of raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!next.includes(s)) next.push(s);
    if (next.length !== items.length) onChange(next);
    setText('');
  };
  const bad = validate ? items.filter((s) => !validate(s)).length : 0;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1 rounded-md border bg-background px-1.5 py-1 min-h-8">
        {items.map((s) => {
          const ok = !validate || validate(s);
          return (
            <span key={s} title={ok ? s : `Not a valid email: ${s}`}
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-mono ${ok ? 'bg-muted' : 'bg-destructive/15 text-destructive ring-1 ring-destructive/50'}`}>
              {s}
              <button type="button" className="opacity-60 hover:opacity-100" title={`Remove ${s}`} onClick={() => onChange(items.filter((x) => x !== s))}><X className="w-3 h-3" /></button>
            </span>
          );
        })}
        <input className="flex-1 min-w-32 bg-transparent text-xs outline-none px-1" value={text} placeholder={items.length ? 'add…' : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && text.trim()) { e.preventDefault(); add(text); }
            else if (e.key === 'Backspace' && !text && items.length) onChange(items.slice(0, -1));
          }}
          onPaste={(e) => { e.preventDefault(); add(text + ' ' + e.clipboardData.getData('text')); }}
          onBlur={() => text.trim() && add(text)} />
      </div>
      <p className="text-[10px] text-muted-foreground">{items.length} {items.length === 1 ? 'entry' : 'entries'}{bad > 0 && <span className="text-destructive"> · {bad} invalid</span>}</p>
    </div>
  );
}

/** Row actions shared by Principals and Audit. Only `user:`/`internal:` principals carry revocable tokens. Both actions
 *  change the policy document, so `onPolicyChange` refreshes its version (else the next Save would 409). */
export function principalActions(call: OwnerCall, onPolicyChange: () => Promise<void>, ownerIds: string[] = []) {
  return {
    canRevoke: (id: string) => /^(user|internal):/.test(id) && id !== 'internal:agent-internal',
    /** UI hint only (ownerIds from GET /policy) — the server refuses a block that matches an owner. */
    canBlock: (id: string) => !ownerIds.includes(id),
    revoke: async (id: string) => {
      if (!confirm(`Revoke every token issued to ${id}? They must sign in again.`)) return;
      await call('/tokens/revoke', 'POST', { principalId: id });
      await onPolicyChange();
    },
    block: async (id: string) => {
      const reason = prompt(`Block ${id}? Reason (optional):`);
      if (reason === null) return;
      await call('/blocks', 'POST', { match: { id }, until: null, reason });
      await onPolicyChange();
    },
  };
}
