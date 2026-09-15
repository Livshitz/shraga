import { useEffect, useState } from 'react';
import { AlertTriangle, PlugZap, RefreshCw, ServerCrash, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type BackendFault, type BackendFaultKind, subscribeBackendHealth } from '@/lib/backendHealth';

/**
 * Persistent, always-visible banner naming a broken backend, so a user can diagnose a dead page FROM
 * THE UI instead of opening devtools or asking an agent. Zero props on purpose: it reads the shared
 * {@link subscribeBackendHealth} store, which the shared fetch helpers and the AgentSocket feed, so a
 * shell only has to render it once. It clears itself the moment the store reports recovery.
 *
 * Mount it ABOVE the login gate as well as inside the authenticated shell. A hijacked backend breaks
 * the unauthenticated `/api/auth/mode` probe too, so a pre-login user would otherwise face a sign-in
 * that can never succeed with nothing on screen saying why. It stays silent in the ORDINARY pre-login
 * state: a healthy probe carries the identity header, and the classifier ignores 401/403 outright.
 */

const STYLE: Record<BackendFaultKind, { icon: typeof AlertTriangle; classes: string }> = {
  'wrong-backend': { icon: PlugZap, classes: 'bg-red-600 text-white border-red-700' },
  offline: { icon: WifiOff, classes: 'bg-red-600 text-white border-red-700' },
  'server-error': { icon: ServerCrash, classes: 'bg-amber-500 text-amber-950 border-amber-600' },
  'ws-down': { icon: AlertTriangle, classes: 'bg-amber-500 text-amber-950 border-amber-600' },
};

export function BackendStatusBanner() {
  const [fault, setFault] = useState<BackendFault | null>(null);
  useEffect(() => subscribeBackendHealth(setFault), []);

  if (!fault) return null;
  const { icon: Icon, classes } = STYLE[fault.kind];

  return (
    <div
      role="alert"
      data-testid="backend-status-banner"
      data-fault-kind={fault.kind}
      className={cn('shrink-0 border-b px-3 py-2 text-xs', classes)}
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      <div className="flex items-start gap-2">
        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{fault.title}</div>
          <div className="opacity-90 mt-0.5">{fault.hint}</div>
          {(fault.path || fault.status !== undefined) && (
            <div className="opacity-75 mt-0.5 font-mono text-[11px] break-all">
              {fault.path ?? 'websocket'}
              {fault.status !== undefined ? ` → ${fault.status}` : ''}
            </div>
          )}
        </div>
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 inline-flex items-center gap-1 rounded bg-white/20 hover:bg-white/30 px-2 py-1 font-semibold transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      </div>
    </div>
  );
}
