import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { signInternalToken } from '../auth.ts';
import { buildHooks } from '../hooks.ts';
import { listSkills } from '../skills.ts';
import { loadAgents } from '../agents.ts';
import { registerProactiveMessage } from '../slack/sessions.ts';
import { registerPoll } from '../polls.ts';
import { getSession, setSessionModel, getSessionModel, type ConvMessage } from '../sessions.ts';
import { DEFAULT_MODEL } from '../directives.ts';
import { resolveModelSwitch } from '../model-aliases.ts';
import type { WsEvent, AskQuestion, QuestionAnswers, QuestionHandler } from '../claude.ts';
import type { AgentEngine, EngineStreamOpts, EngineModel } from './types.ts';
import { getPromptSuffix } from '../prompt-suffix.ts';
import { APP_ROOT } from '../paths.ts';
const IMMUTABLE_SYSTEM_PROMPT = readFileSync(path.resolve(import.meta.dirname, '../../../defaults/system-prompt.md'), 'utf-8');
const DEFAULT_USER_PROMPT = `You are a helpful assistant with access to MCP tools.`;
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Bash', 'WebSearch', 'Glob', 'LS', 'ToolSearch'];
const BG_TASK_MAX_WAIT_MS = 15 * 60_000;
const HISTORY_LIMIT = 50;

const NO_INTERACTIVE_ANSWER = 'No interactive channel is available to answer right now. Use your best judgement to proceed, and surface these options to the user in your reply so they can redirect if needed.';

const SENSITIVE_PATTERNS = [
  /\.env($|\.)/i, /secrets?\//i, /credentials/i, /\.pem$/i, /\.key$/i,
  /service.account.*\.json/i, /\/\.claude\/credentials/i,
];
const SENSITIVE_BASH_PATTERNS = [
  /\.env\b/i, /\bprintenv\b/i, /\b(env|set)\s*\|/i, /\bsecrets?\//i,
  /credentials/i, /service.account/i, /\.(pem|key)\b/i,
  /\$[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)\b/i, /process\.env/i,
];
const DESTRUCTIVE_DATA_PATTERNS = [
  /\b(rm|rmdir|unlink|mv)\b.*\bdata\/(conversations?|sessions?|schedules?)\b/i,
  /\b(rm|rmdir|unlink|mv)\b.*\b(whitelist\.json|api-keys\.json|agent-config\.json)\b/i,
  /\bfind\b.*\bdata\/(conversations?|sessions?|schedules?).*(-delete|-exec\s+rm)\b/i,
  />\s*data\/(conversations?|sessions?|schedules?)\//i,
];

type DenyResult = { behavior: 'deny'; message: string };

function checkSensitiveAccess(toolName: string, input: Record<string, unknown>): DenyResult | null {
  const filePath = (input.file_path ?? input.path ?? '') as string;
  if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') && filePath) {
    if (SENSITIVE_PATTERNS.some(p => p.test(filePath))) {
      console.log(`[security] Blocked ${toolName} on sensitive file: ${filePath}`);
      return { behavior: 'deny', message: 'Access to sensitive files (.env, secrets, credentials) is blocked.' };
    }
  }
  if (toolName === 'Bash') {
    const cmd = (input.command ?? '') as string;
    if (SENSITIVE_BASH_PATTERNS.some(p => p.test(cmd))) {
      console.log(`[security] Blocked Bash command targeting sensitive data: ${cmd.slice(0, 80)}`);
      return { behavior: 'deny', message: 'Commands accessing sensitive files or environment secrets are blocked.' };
    }
  }
  return null;
}

function isDestructiveDataOp(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'Bash') return false;
  return DESTRUCTIVE_DATA_PATTERNS.some(p => p.test((input.command ?? '') as string));
}

function buildHistoryPrompt(conv: ConvMessage[], contextBlock: string, userPrompt: string): string {
  if (!conv.length) {
    return contextBlock ? `${contextBlock}\n\n${userPrompt}` : userPrompt;
  }
  const summaryIdx = conv.findLastIndex((m) => m.blocks.some((b) => b.type === 'summary'));
  let summary: string | null = null;
  let recent: ConvMessage[];
  if (summaryIdx >= 0) {
    summary = (conv[summaryIdx].blocks.find((b) => b.type === 'summary') as any)?.text ?? null;
    recent = conv.slice(summaryIdx + 1).slice(-HISTORY_LIMIT);
  } else {
    recent = conv.slice(-HISTORY_LIMIT);
  }

  const parts: string[] = [];
  if (summary) parts.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);
  for (const m of recent) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const texts = m.blocks
      .filter((b) => b.type === 'text' || b.type === 'context')
      .map((b) => {
        if (b.type === 'context') return `[${(b as any).label}]: ${(b as any).text}`;
        return (b as { type: 'text'; text: string }).text;
      })
      .filter(Boolean);
    if (texts.length) parts.push(`${role}: ${texts.join('\n')}`);
  }

  if (parts.length) {
    const prefix = contextBlock ? `${contextBlock}\n\n` : '';
    return `${prefix}<conversation_history>\n${parts.join('\n\n')}\n</conversation_history>\n\nUser: ${userPrompt}`;
  }
  return contextBlock ? `${contextBlock}\n\n${userPrompt}` : userPrompt;
}

/**
 * Log prompt-cache effectiveness from the SDK result `usage`. The hit rate is
 * cache_read / (cache_read + cache_creation + uncached input) — a low rate over
 * many turns points to a silent prefix invalidator or sessions spread past the
 * 5-min cache TTL. Note: cross-turn history is re-sent uncached (single-shot
 * prompt per query, no SDK resume) — so hit rate tracks tool density per turn.
 */
function logCacheUsage(usage: any, model: string): void {
  if (!usage) return;
  const read = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const totalIn = read + created + fresh;
  if (totalIn === 0) return;
  const hitRate = ((read / totalIn) * 100).toFixed(1);
  console.log(`[claude] Cache: hit=${hitRate}% read=${read} write=${created} uncached=${fresh} out=${usage.output_tokens ?? 0} model=${model}`);
}

const INLINE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

async function* buildAttachmentPrompt(text: string, attachments: { path: string; name: string; mimeType: string }[], sessionId: string): AsyncIterable<any> {
  const content: any[] = [];
  const fileRefs: string[] = [];
  const audioRefs: string[] = [];
  for (const att of attachments) {
    if (INLINE_MIMES.has(att.mimeType)) {
      try {
        const buf = readFileSync(att.path);
        const blockType = att.mimeType === 'application/pdf' ? 'document' : 'image';
        content.push({ type: blockType, source: { type: 'base64', media_type: att.mimeType, data: buf.toString('base64') } });
      } catch (err) {
        console.error(`[claude] Failed to read attachment ${att.path}:`, err);
        fileRefs.push(`${att.name} (at ${att.path} — failed to read)`);
      }
    } else if (att.mimeType.startsWith('audio/')) {
      // The model can't ingest audio directly — pass the path and route to mcp-audio.
      audioRefs.push(`${att.name} (at ${att.path})`);
    } else {
      fileRefs.push(`${att.name} (at ${att.path})`);
    }
  }
  if (audioRefs.length > 0) text += `\n\n[Audio attached — transcribe with the mcp-audio tool (post_audio_transcribe { file }) before answering]: ${audioRefs.join(', ')}`;
  if (fileRefs.length > 0) text += `\n\n[Attached files — use Read tool to access]: ${fileRefs.join(', ')}`;
  content.push({ type: 'text', text });
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId };
}

async function* buildLegacyImagePrompt(text: string, images: string[], sessionId: string): AsyncIterable<any> {
  const content: any[] = images.map((dataUrl) => {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const blockType = match[1] === 'application/pdf' ? 'document' : 'image';
    return { type: blockType, source: { type: 'base64', media_type: match[1], data: match[2] } };
  }).filter(Boolean);
  content.push({ type: 'text', text });
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId };
}

export class ClaudeCodeEngine implements AgentEngine {
  readonly name = 'claude-code';

  getModels(): EngineModel[] {
    return [
      { value: '', label: `Default (${DEFAULT_MODEL})` },
      { value: 'claude-fable-5', label: 'Fable 5 — frontier, most capable' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
    ];
  }

  async *stream(opts: EngineStreamOpts): AsyncGenerator<WsEvent> {
    const { config, directives } = opts;
    const cwd = APP_ROOT;

    const fullPrompt = buildHistoryPrompt(opts.conversation, opts.contextBlock, opts.prompt);
    const permMode = opts.onPermissionRequest ? 'default' : (config.permissionMode ?? 'acceptEdits');

    const sdkEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) sdkEnv[k] = v;
    }
    // Injected for the agent's own tools/scripts. Each is written under both the canonical
    // `SHRAGA_*` name and the legacy `UNCLAW_*` one — deployed workspaces still contain scripts
    // and extensions that read the legacy names, and we don't control those callers.
    sdkEnv.SHRAGA_USER_UID = sdkEnv.UNCLAW_USER_UID = opts.uid;
    if (opts.userEmail) sdkEnv.SHRAGA_USER_EMAIL = sdkEnv.UNCLAW_USER_EMAIL = opts.userEmail;
    sdkEnv.SHRAGA_SESSION_ID = sdkEnv.UNCLAW_SESSION_ID = opts.sessionId ?? '';
    sdkEnv.INTERNAL_API_TOKEN = signInternalToken(opts.uid, opts.userEmail || 'unknown');

    const baseAllowed = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const allowedTools = baseAllowed.includes('ToolSearch') ? baseAllowed : [...baseAllowed, 'ToolSearch'];
    const maxTurns = directives.turns ?? config.maxTurns ?? 50;

    const options: Record<string, unknown> = {
      tools: { type: 'preset', preset: 'claude_code' },
      env: sdkEnv,
      allowedTools,
      cwd,
      permissionMode: permMode === 'bypassPermissions' ? 'acceptEdits' : permMode,
      maxTurns,
      includePartialMessages: true,
      // The SDK `skills` option is a context filter over skills the SDK DISCOVERS on disk
      // (.claude/skills / settingSources / plugins) — NOT our DATA_DIR/skills. We never point the
      // SDK at that dir, so these names match nothing: the built-in `Skill` tool turns on but can
      // resolve zero of them → every Skill{name} returns "Unknown skill". Our real skill path is
      // trigger-injection + the <available-skills> index (which tells the model to `Read` them).
      // Disable the phantom tool so the model doesn't waste a turn (and then fly blind) on it.
      skills: listSkills(),
      disallowedTools: ['Skill'],
      agents: loadAgents(),
      hooks: buildHooks(),
    };

    const userHandler = opts.onPermissionRequest;
    const destructiveHandler = opts.onDestructiveApproval;
    const questionHandler = opts.onUserQuestion;
    options['canUseTool'] = async (toolName: string, input: Record<string, unknown>) => {
      const denied = checkSensitiveAccess(toolName, input);
      if (denied) return denied;
      if (toolName === 'AskUserQuestion') {
        const questions = (input.questions ?? []) as AskQuestion[];
        const answers = questionHandler
          ? await questionHandler(crypto.randomUUID(), questions).catch((err) => {
              console.error(`[claude] onUserQuestion failed:`, (err as Error)?.message);
              return null;
            })
          : null;
        if (answers && Object.keys(answers).length) {
          return { behavior: 'allow' as const, updatedInput: { ...input, questions, answers } };
        }
        const sentinel: QuestionAnswers = {};
        for (const q of questions) sentinel[q.question] = NO_INTERACTIVE_ANSWER;
        return { behavior: 'allow' as const, updatedInput: { ...input, questions, answers: sentinel } };
      }
      if (isDestructiveDataOp(toolName, input)) {
        const cmd = ((input.command ?? '') as string).slice(0, 100);
        console.log(`[security] Destructive data op requires approval: ${cmd}`);
        if (destructiveHandler) {
          const id = crypto.randomUUID();
          const result = await destructiveHandler(id, toolName, input);
          if (result.allow) return { behavior: 'allow' as const, updatedInput: input };
          return { behavior: 'deny' as const, message: 'User denied this destructive action' };
        }
        return { behavior: 'deny' as const, message: 'Destructive data operations require interactive approval.' };
      }
      if (userHandler) {
        const id = crypto.randomUUID();
        const result = await userHandler(id, toolName, input);
        if (result.allow) return { behavior: 'allow' as const, updatedInput: input };
        return { behavior: 'deny' as const, message: 'User denied this action' };
      }
      return { behavior: 'allow' as const, updatedInput: input };
    };

    // Always pass an explicit model — left unset, the CLI applies its own default
    // (observed: Opus 4.7), not what the UI's "Default" label promises.
    options['model'] = directives.model ?? config.model ?? DEFAULT_MODEL;
    const thinkingMode = directives.thinking ?? config.thinking;
    if (thinkingMode) options['thinking'] = thinkingMode === 'enabled' ? { type: 'enabled' } : { type: thinkingMode };
    const effort = directives.effort ?? config.effort;
    if (effort) options['effort'] = effort;

    const userPrompt = config.systemPrompt || DEFAULT_USER_PROMPT;
    // Optional add-ons may append a system-prompt suffix decided off the opaque turn hints (add-on-owned
    // text). With nothing registered (CE's own state) this is '' and the prompt is byte-identical to before.
    const addonSuffix = getPromptSuffix(opts.turnHints);
    options['systemPrompt'] = `${IMMUTABLE_SYSTEM_PROMPT}\n\n${userPrompt}${addonSuffix ? `\n\n${addonSuffix}` : ''}`;
    if (opts.abortController) options['abortController'] = opts.abortController;
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) options['mcpServers'] = opts.mcpServers;

    const mcpNames = opts.mcpServers ? Object.keys(opts.mcpServers) : [];
    const activeModel = (options['model'] as string) || 'default';
    const directivesTag = Object.keys(directives).length ? ` directives=${JSON.stringify(directives)}` : '';
    console.log(`[claude] Starting query user=${opts.uid} session=${opts.sessionId ?? 'new'} model=${activeModel} perms=${config.permissionMode} mcps=[${mcpNames.join(',')}]${directivesTag} cwd=${cwd}`);
    const startTime = Date.now();
    const elapsed = () => `${Date.now() - startTime}ms`;

    const sessionKey = opts.sessionId ?? crypto.randomUUID();
    const hasAttachments = opts.attachments && opts.attachments.length > 0;
    const hasLegacyImages = opts.images && opts.images.length > 0;
    const prompt = hasAttachments
      ? buildAttachmentPrompt(fullPrompt, opts.attachments!, sessionKey)
      : hasLegacyImages
        ? buildLegacyImagePrompt(fullPrompt, opts.images!, sessionKey)
        : fullPrompt;

    const q = query({ prompt, options: options as any });

    let lastSessionId = '';
    let messageCount = 0;
    let textDeltaCount = 0;
    let turnCount = 0;
    const pendingToolUses = new Map<string, { tool: string; input: any }>();
    const streamedToolUseIds = new Set<string>();
    const streamingToolInputsByIndex = new Map<number, { id: string; name: string; inputJson: string }>();
    const outstandingTasks = new Set<string>();

    const iter = q[Symbol.asyncIterator]();
    let pendingNext: Promise<IteratorResult<any>> | null = null;
    let waitingForBg = false;
    let bgTimer: Promise<'__bgtimeout'> | null = null;
    let bgTimerHandle: ReturnType<typeof setTimeout> | null = null;
    const clearBgTimer = () => { if (bgTimerHandle) { clearTimeout(bgTimerHandle); bgTimerHandle = null; } bgTimer = null; };

    try {
      while (true) {
        if (!pendingNext) pendingNext = iter.next();
        let res: IteratorResult<any>;
        if (waitingForBg) {
          if (!bgTimer) bgTimer = new Promise((r) => { bgTimerHandle = setTimeout(() => r('__bgtimeout'), BG_TASK_MAX_WAIT_MS); });
          const raced = await Promise.race([pendingNext, bgTimer]);
          if (raced === '__bgtimeout') {
            console.warn(`[claude] Background-task wait timed out (${elapsed()})`);
            yield { type: 'done', sessionId: lastSessionId, stopReason: 'end_turn' };
            return;
          }
          res = raced as IteratorResult<any>;
        } else {
          res = await pendingNext;
        }
        pendingNext = null;
        if (res.done) break;
        const m = res.value as any;
        messageCount++;

        if (m.session_id && !lastSessionId) {
          lastSessionId = m.session_id;
          console.log(`[claude] Got session_id=${lastSessionId} at msg #${messageCount} (${elapsed()})`);
        }

        if (m.type === 'system' && m.subtype === 'init') {
          // Which credentials the SDK actually resolved (env key vs claude.ai login) — a process-global
          // fact surfaced per-run so logs (incl. headless/scheduler) answer "subscription or API key?".
          // Runtime `apiKeySource` is the RESOLVED source string (verified against the SDK, not its .d.ts
          // enum): a named env var ("ANTHROPIC_API_KEY") ⇒ API key; "none"/"oauth" ⇒ stored login ⇒ sub.
          const src = m.apiKeySource as string | undefined;
          const authSource: 'subscription' | 'api-key' | undefined =
            src == null ? undefined : src === 'none' || src === 'oauth' ? 'subscription' : 'api-key';
          if (authSource) console.log(`[claude] Auth: ${authSource} (apiKeySource=${src})`);
          if (m.model) {
            console.log(`[claude] Init model=${m.model}${m.model !== options['model'] ? ` (requested ${options['model']})` : ''}`);
            // If the user explicitly asked to switch models via a [directive], announce the change
            // inline so the response confirms the switch took effect.
            const sw = resolveModelSwitch({
              requested: opts.directives.model ? m.model : undefined,
              current: m.model,
              prior: opts.sessionId ? getSessionModel(opts.sessionId) : undefined,
            });
            if (sw.notice) yield { type: 'text_delta', text: sw.notice };
            if (opts.sessionId) setSessionModel(opts.sessionId, m.model);
            // Live ground-truth so the header pill confirms the actually-resolved model mid-turn
            // (catches inline overrides like [opus] and silent rate-limit fallbacks) instead of
            // only updating on session reload.
            yield { type: 'model_resolved', sessionId: opts.sessionId ?? '', model: m.model };
          }
          const servers = m.mcp_servers;
          if (Array.isArray(servers) && servers.length > 0) {
            console.log(`[claude] MCP: ${servers.map((s: any) => `${s.name}:${s.status}`).join(', ')}`);
          }
          continue;
        }

        if (m.type === 'system' && m.subtype === 'task_started') {
          outstandingTasks.add(m.task_id);
          console.log(`[claude] Background task started: ${m.task_id} (${outstandingTasks.size} pending) (${elapsed()})`);
          continue;
        }
        if (m.type === 'system' && m.subtype === 'task_notification') {
          outstandingTasks.delete(m.task_id);
          console.log(`[claude] Background task ${m.status}: ${m.task_id} (${outstandingTasks.size} pending) (${elapsed()})`);
          if (outstandingTasks.size === 0) { waitingForBg = false; clearBgTimer(); }
          continue;
        }

        if (m.type === 'system') continue;

        if (m.type === 'result') {
          lastSessionId = m.session_id || lastSessionId;
          const sdkTurns = m.num_turns ?? 0;
          const raw = m.subtype ?? 'unknown';
          const sub = raw === 'error_max_turns' || (raw === 'end_turn' && sdkTurns >= maxTurns) ? 'max_turns_reached' : raw;
          console.log(`[claude] Result: subtype=${m.subtype}→${sub} session=${lastSessionId} turns=${sdkTurns}/${maxTurns} cost=$${m.total_cost_usd?.toFixed(4) ?? '?'} msgs=${messageCount} deltas=${textDeltaCount} (${elapsed()})`);
          logCacheUsage(m.usage, activeModel);
          if (outstandingTasks.size > 0) {
            if (!waitingForBg) { waitingForBg = true; clearBgTimer(); console.log(`[claude] Holding stream for ${outstandingTasks.size} bg tasks (${elapsed()})`); }
            continue;
          }
          if (textDeltaCount === 0) {
            console.warn(`[claude] Empty response — result keys: ${Object.keys(m).join(',')}`);
          }
          yield { type: 'done', sessionId: lastSessionId, stopReason: sub };
          return;
        }

        if (m.type === 'stream_event') {
          const event = m.event;
          if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: event.delta.thinking };
          }
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            textDeltaCount++;
            yield { type: 'text_delta', text: event.delta.text };
          }
          if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const { id, name } = event.content_block;
            const idx = event.index ?? -1;
            streamedToolUseIds.add(id);
            streamingToolInputsByIndex.set(idx, { id, name, inputJson: '' });
            yield { type: 'tool_use', tool: name, toolUseId: id, input: {} };
          }
          if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            const entry = streamingToolInputsByIndex.get(event.index ?? -1);
            if (entry) {
              entry.inputJson += event.delta.partial_json ?? '';
              yield { type: 'tool_use_input', toolUseId: entry.id, input: entry.inputJson };
            }
          }
          continue;
        }

        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          turnCount++;
          for (const block of m.message.content) {
            if (block.type === 'tool_use') {
              pendingToolUses.set(block.id, { tool: block.name, input: block.input });
              if (streamedToolUseIds.has(block.id)) {
                yield { type: 'tool_use_input', toolUseId: block.id, input: block.input };
              } else {
                yield { type: 'tool_use', tool: block.name, toolUseId: block.id, input: block.input };
              }
            }
          }
          streamingToolInputsByIndex.clear();
          continue;
        }

        if (m.type === 'user' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            if (block.type === 'tool_result') {
              const contentArr = Array.isArray(block.content) ? block.content : [];
              const output = contentArr.length > 0
                ? contentArr.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('')
                : String(block.content ?? '');
              yield { type: 'tool_result', toolUseId: String(block.tool_use_id), output };

              let foundImage = false;
              for (const c of contentArr) {
                if (c.type === 'image') {
                  foundImage = true;
                  if (c.source?.type === 'base64' && c.source?.data) {
                    yield { type: 'tool_result_image', toolUseId: String(block.tool_use_id), dataUrl: `data:${c.source.media_type || 'image/png'};base64,${c.source.data}` };
                  } else if (c.data && c.mimeType) {
                    yield { type: 'tool_result_image', toolUseId: String(block.tool_use_id), dataUrl: `data:${c.mimeType};base64,${c.data}` };
                  }
                }
              }
              if (!foundImage && output.includes('"dataUrl":"data:')) {
                try {
                  const parsed = JSON.parse(output);
                  if (parsed.dataUrl?.startsWith('data:')) {
                    yield { type: 'tool_result_image', toolUseId: String(block.tool_use_id), dataUrl: parsed.dataUrl };
                  }
                } catch (e) { console.warn('[claude] Failed to parse dataUrl from tool result text', e); }
              }

              const pending = pendingToolUses.get(String(block.tool_use_id));
              if (pending?.tool === 'mcp__mcp-slack-use__post_slack_message') {
                try {
                  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
                  const ts = parsed?.ts || parsed?.preview?.ts;
                  const inp = pending.input as any;
                  const channel = inp?.body?.channel || inp?.channel_id || inp?.channel;
                  const sid = opts.sessionId || lastSessionId;
                  if (ts && channel && sid) {
                    const session = getSession(sid);
                    registerProactiveMessage(channel, ts, sid, session?.title || sid);
                  }
                } catch (err) { console.warn('[claude] Failed to track proactive message:', (err as Error).message); }
              }
              if (pending?.tool === 'mcp__mcp-slack-use__post_slack_poll') {
                try {
                  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
                  const body = ((pending.input as any)?.body ?? {}) as Record<string, any>;
                  const sid = opts.sessionId || lastSessionId;
                  if (parsed?.ok && parsed.pollId && parsed.ts && parsed.channel && sid) {
                    registerPoll({
                      pollId: parsed.pollId, channel: parsed.channel, ts: parsed.ts, title: String(body.title ?? ''),
                      options: parsed.options ?? body.options ?? [], kind: parsed.kind ?? 'poll',
                      multi: parsed.multi, targetUser: parsed.targetUser,
                      deadlineMinutes: typeof body.deadline_minutes === 'number' ? body.deadline_minutes : undefined,
                      quorum: typeof body.quorum === 'number' ? body.quorum : undefined,
                      sessionId: sid, uid: opts.uid, userEmail: opts.userEmail,
                    });
                  }
                } catch (err) { console.warn('[claude] Failed to register poll:', (err as Error).message); }
              }
              pendingToolUses.delete(String(block.tool_use_id));
            }
          }
          continue;
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || opts.abortController?.signal.aborted) {
        console.log(`[claude] Stream aborted after ${messageCount} msgs (${elapsed()})`);
        return;
      }
      console.error(`[claude] Error after ${messageCount} msgs (${elapsed()}):`, err.message || err);
      yield { type: 'error', message: err.message || String(err) };
      return;
    } finally {
      clearBgTimer();
    }

    const inferredReason = turnCount >= maxTurns ? 'max_turns_reached' : 'end_turn';
    console.warn(`[claude] Stream ended without result. session=${lastSessionId || 'none'} msgs=${messageCount} turns=${turnCount}/${maxTurns} (${elapsed()})`);
    if (lastSessionId) {
      yield { type: 'done', sessionId: lastSessionId, stopReason: inferredReason };
    }
  }
}
