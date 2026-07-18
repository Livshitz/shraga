/**
 * SDK hooks — PreToolUse / PostToolUse callbacks wired into query().
 *
 * Hooks intercept tool calls inside the Claude Code CLI subprocess.
 * Unlike `canUseTool` (permission gate), hooks can modify input, inject
 * context, and guide model behavior through denial reasons.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { rewriteSlackMentions } from './slack/mention-rewrite.ts';

/** Patterns that indicate a long-running script the model should background. */
const LONG_RUNNING_PATTERNS = [
  /\bdata\/scripts\//,
];

/**
 * Deny foreground Bash calls matching known long-running patterns.
 * The denial reason tells the model to retry with `run_in_background: true`,
 * which lets the CLI manage the process asynchronously (the model can
 * continue working and gets notified when the command finishes).
 */
const forceBackgroundForScripts: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  if (tool_name !== 'Bash') return {};

  const ti = tool_input as Record<string, unknown>;
  const cmd = ti.command as string | undefined;
  if (!cmd || ti.run_in_background) return {};

  const isLongRunning = LONG_RUNNING_PATTERNS.some(p => p.test(cmd));
  if (!isLongRunning) return {};

  console.log(`[hooks] Denying foreground Bash for long-running script: ${cmd.slice(0, 120)}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason:
        'This script may take several minutes. Use run_in_background: true so you can continue working while it runs.',
    },
  };
};

/**
 * Text fields per Slack MCP tool that may carry `@name` prose the agent typed.
 * (Not `post_slack_poll` — its options are structured labels, not mention prose.)
 */
const SLACK_MENTION_FIELDS: Record<string, string[]> = {
  post_slack_message: ['text'],
  post_slack_update: ['text'],
  post_slack_reply: ['text'],
  post_slack_files: ['initial_comment'],
};

/**
 * Rewrite human-readable `@name (operator)` / `@name` display strings in
 * outbound Slack text back into real `<@U…>` mention tokens, so mentions the
 * agent typed from its readable context actually fire a notification.
 * Closes the inbound/outbound asymmetry (resolveUserMentions has no reverse).
 */
const resolveSlackMentions: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const m = /^mcp__mcp-slack-use__(post_slack_\w+)$/.exec(tool_name);
  if (!m) return {};
  const fields = SLACK_MENTION_FIELDS[m[1]];
  if (!fields) return {};

  const ti = { ...(tool_input as Record<string, unknown>) };
  let changed = false;
  for (const f of fields) {
    const val = ti[f];
    if (typeof val !== 'string') continue;
    const r = rewriteSlackMentions(val);
    if (r.changed) { ti[f] = r.text; changed = true; }
  }
  if (!changed) return {};

  console.log(`[hooks] Resolved @name display strings to <@U…> mention tokens in ${tool_name}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      updatedInput: ti,
    },
  };
};

/**
 * Guardrail for the AGF Firebase RTDB MCPs. The `agf-rtdb` skill's rules only bind
 * the model when that skill is loaded — but it auto-injects only on a trigger match,
 * so a query phrased without the trigger vocabulary (e.g. "the currently alive room")
 * leaves the model flying blind. It then does the exact thing Rule #1 forbids:
 * `get_db path=agf` (or `agf/session`) → a whole-DB read that errors `too_big` / hangs.
 * This deny is a HARD backstop independent of phrasing or the model remembering: block
 * the two dangerous shapes and hand back the corrective recipe + a pointer to the skill.
 */
const FIREBASE_HUGE_PATHS = new Set(['', 'agf', 'agf/session']);
const norm = (p: unknown) => String(p ?? '').trim().replace(/^\/+|\/+$/g, '');

const guardFirebaseReads: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const m = /^mcp__mcp-firebase-(?:prod|lab)__(get_db|get_db_keys|get_db_query)$/.exec(tool_name);
  if (!m) return {};
  const method = m[1];
  const ti = tool_input as Record<string, unknown>;
  const path = norm(ti.path);

  let reason: string | null = null;
  // Rule #1: full-value read of a HUGE node. (get_db_keys is keys-only → safe even on agf.)
  if (method === 'get_db' && FIREBASE_HUGE_PATHS.has(path)) {
    reason = `Blocked: get_db on "${path || '/'}" reads the whole node — it errors too_big / hangs (agf-rtdb skill Rule #1: never read /agf or /agf/session directly). ` +
      `For the currently-active session(s): get_db_query path=agf/session orderBy="timing/status" equalTo="Active" limitToFirst=10 (status is Capitalized + case-sensitive). ` +
      `Then drill into small sub-paths (…/timing, …/participantsActivity, …/speakers) — never the full session node. Read data/skills/agf-rtdb.md for the full recipes.`;
  } else if (method === 'get_db_query' && !norm(ti.orderBy)) {
    // Rule #2: query without orderBy pulls the whole node first.
    reason = `Blocked: get_db_query without orderBy pulls the entire node before filtering (agf-rtdb skill Rule #2). ` +
      `Add an INDEXED orderBy: on agf/session use "timing/status" or "timing/startTime"; any push-keyed list uses "$key". Read data/skills/agf-rtdb.md for indexed fields.`;
  }
  if (!reason) return {};

  console.log(`[hooks] Firebase guardrail blocked ${tool_name} path="${path}" — steering to agf-rtdb skill`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
};

/** Build the hooks map to pass into SDK query() options. */
export function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [forceBackgroundForScripts] },
      { matcher: 'mcp__mcp-slack-use__post_slack_.*', hooks: [resolveSlackMentions] },
      { matcher: 'mcp__mcp-firebase-(?:prod|lab)__get_db.*', hooks: [guardFirebaseReads] },
    ],
  };
}
