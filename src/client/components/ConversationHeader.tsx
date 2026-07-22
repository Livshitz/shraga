import { useState } from 'react';
import { Copy, Check, Clock, GitFork, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfigPanel } from '@/components/ConfigPanel';
import type { AgentConfig } from '@/lib/workspaceContext';

interface SessionDirectives {
  model?: string;
  turns?: number;
  thinking?: string;
  engine?: string;
}

function InfoBadges({
  sessionId,
  config,
  sessionDirectives,
  actualModel,
  scheduleId,
  onScheduleClick,
}: {
  sessionId?: string;
  config: AgentConfig;
  sessionDirectives?: SessionDirectives;
  /** Model the engine actually resolved at runtime (session meta `lastModel`) — beats configured/requested. */
  actualModel?: string;
  scheduleId?: string;
  onScheduleClick?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const engine = sessionDirectives?.engine || config.engine || 'claude-code';
  // The native Claude Code engine records a bare `claude-*` id; a multi-provider add-on engine records
  // a `provider/model` id. Trust the recorded model only when its shape matches the current engine
  // family, or a session that has since switched engines would show the previous engine's model.
  const recordedByNative = actualModel ? !actualModel.includes('/') : undefined;
  const engineIsNative = engine === 'claude-code' || engine === 'cursor';
  const trustedActual = recordedByNative !== undefined && recordedByNative === engineIsNative ? actualModel : undefined;
  const rawModel =
    trustedActual || sessionDirectives?.model || config.model || (engine === 'cursor' ? 'cursor/composer-2.5' : 'sonnet-4-6');
  // A multi-provider add-on engine runs any provider's model through its own loop, so it must be
  // distinguishable from a native runtime running the same model. Prefix such a model with the engine
  // name; native engines (claude-code, cursor) show the model plainly. Engine name comes from data.
  const model = !engineIsNative ? `${engine} · ${rawModel.replace('claude-', '')}` : rawModel.replace('claude-', '');
  // Auth-mechanism indicator. The only verifiable distinction is claude.ai OAuth login vs a provider
  // API key: the native claude-code engine can run on a login (no ANTHROPIC_API_KEY); every add-on
  // engine / provider-prefixed model runs on that provider's key (ai.libx.js adapters throw without
  // one). What that key COSTS is plan-dependent and NOT knowable here (Anthropic API is metered;
  // a Cursor key may draw on a Cursor subscription) — so we label the mechanism, not the billing.
  // Provider = the model's prefix (bare ⇒ anthropic).
  const billingProvider = rawModel.includes('/') ? rawModel.split('/')[0] : 'anthropic';
  const onSubscription = engine === 'claude-code' && config.claudeAuthSource === 'subscription';
  // Tone: green = claude.ai login (no key); amber = provider key whose usage may be subscription-
  // covered (Cursor); rose = provider key that is genuinely metered (Anthropic/OpenAI/etc.).
  const billingTone = onSubscription ? 'sub' : billingProvider === 'cursor' ? 'plan' : 'metered';
  const billingClass =
    billingTone === 'sub'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/30'
      : billingTone === 'plan'
        ? 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-400/30'
        : 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-400/30';
  const billingTitle =
    billingTone === 'sub'
      ? 'Claude.ai subscription (OAuth login) — no API key in use'
      : billingTone === 'plan'
        ? `Runs on your ${billingProvider} API key — usage may draw on your ${billingProvider} plan/subscription`
        : `Runs on your ${billingProvider} API key — metered per-token billing`;
  const perms = config.permissionMode || 'acceptEdits';
  const permLabel =
    perms === 'bypassPermissions' ? 'bypass' : perms === 'plan' ? 'plan' : perms === 'default' ? 'prompt' : 'edits';
  const thinking = (sessionDirectives?.thinking || config.thinking) as string | undefined;

  const copySessionId = () => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-400/30">
        {model}
      </span>
      <span
        title={billingTitle}
        className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${billingClass}`}
      >
        {onSubscription ? 'sub' : `API·${billingProvider}`}
      </span>
      <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-400/30">
        {permLabel}
      </span>
      <span className="inline-flex items-center rounded-md bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-950/50 dark:text-green-300 dark:ring-green-400/30">
        {sessionDirectives?.turns ?? config.maxTurns ?? 50} steps
      </span>
      {thinking && thinking !== 'disabled' && (
        <span className="inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-400/30">
          think
        </span>
      )}
      {sessionId && (
        <button
          onClick={copySessionId}
          className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground ring-1 ring-inset ring-border hover:bg-accent transition-colors"
          title={`Session: ${sessionId}\nClick to copy`}
        >
          {sessionId.slice(0, 8)}
          {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
        </button>
      )}
      {scheduleId && (
        <button
          onClick={onScheduleClick}
          className="inline-flex items-center gap-0.5 rounded-md bg-purple-50 px-1.5 py-0.5 text-[10px] font-mono text-purple-700 ring-1 ring-inset ring-purple-600/20 dark:bg-purple-950/50 dark:text-purple-300 dark:ring-purple-400/30 hover:bg-purple-100 dark:hover:bg-purple-950/70 transition-colors"
          title="Open schedule details"
        >
          <Clock className="w-2.5 h-2.5" />
          {scheduleId.slice(0, 8)}
        </button>
      )}
    </div>
  );
}

export interface ConversationHeaderProps {
  sessionId?: string;
  agentConfig: AgentConfig;
  sessionDirectives?: SessionDirectives;
  sessionLastModel?: string;
  sessionScheduleId?: string;
  artifactCount: number;
  getToken: () => Promise<string | null>;
  onConfigSaved: (c: AgentConfig) => void;
  onDirectivesSaved: (d: SessionDirectives | undefined) => void;
  onFork: () => void;
  onToggleArtifacts: () => void;
  onScheduleClick: () => void;
}

/** Per-conversation control strip (badges, fork, config, artifacts) rendered at the top of each pane. */
export function ConversationHeader({
  sessionId,
  agentConfig,
  sessionDirectives,
  sessionLastModel,
  sessionScheduleId,
  artifactCount,
  getToken,
  onConfigSaved,
  onDirectivesSaved,
  onFork,
  onToggleArtifacts,
  onScheduleClick,
}: ConversationHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 border-b bg-background/60 overflow-x-auto">
      <InfoBadges
        sessionId={sessionId}
        config={agentConfig}
        sessionDirectives={sessionDirectives}
        actualModel={sessionLastModel}
        scheduleId={sessionScheduleId}
        onScheduleClick={onScheduleClick}
      />
      <div className="flex-1" />
      {sessionId && (
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onFork} title="Fork conversation">
          <GitFork className="w-3.5 h-3.5" />
        </Button>
      )}
      <ConfigPanel
        getToken={getToken}
        onSaved={onConfigSaved}
        sessionId={sessionId}
        sessionDirectives={sessionDirectives}
        onDirectivesSaved={onDirectivesSaved}
      />
      {artifactCount > 0 && (
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onToggleArtifacts} title="Toggle artifacts panel">
          <Layers className="w-3.5 h-3.5" />
        </Button>
      )}
    </div>
  );
}
