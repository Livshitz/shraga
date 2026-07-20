import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { summarizeText } from './summarize.ts';
import { dataSync } from './data-sync.ts';
import type { McpConfig } from './mcp.ts';
import { loadConversation, saveConversation, appendMessage, getSession, setSessionDirectives, addTriggeredSkills, upsertSession, type ConvMessage, type ConvBlock } from './sessions.ts';
import {
  resolveDefaultSkillsContent,
  expandMentionedSkills,
  buildMcpSkillHintsBlock,
  buildSkillIndexBlock,
  matchTriggeredSkillNames,
  skillInjectionBlocks,
  getSkill,
  getMcpCommandPrompt,
  parseSkillFrontmatter,
} from './skills.ts';

import { buildWorkspaceContextBlock, expandWorkspaceMentions } from './workspace.ts';
import { parseDirectives, type Directives } from './directives.ts';
import { parseSlashCommand, formatCommandBlock } from './commands.ts';
import { getUserContextBlock } from './user-context.ts';
import { collectTurnContext } from './turn-context.ts';
import { DATA_DIR, dataPath } from './paths.ts';
import * as contacts from './contacts.ts';
import { resolveAndGetEngine, resolveEngine } from './engine/index.ts';

const CONFIG_PATH = dataPath('agent-config.json');

// ── Agent config (shared across users) ──────────────────────────────────────

export type { AgentSettings as AgentConfig } from './shraga-config.ts';
import type { AgentSettings as AgentConfig } from './shraga-config.ts';

const DEFAULT_CONFIG: AgentConfig = {
  /** ToolSearch loads deferred MCP tools; without it, permission prompts / tool graph can block Meta Ads tools. */
  allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch', 'Glob', 'LS', 'ToolSearch'],
  permissionMode: 'acceptEdits',
  maxTurns: 15,
  // Defaults are what a fresh self-hosted install runs before anyone touches the UI, so they favour
  // cost/latency over ceiling. Both are overridable per-deployment via agent-config.json and per-send
  // via directives — an operator who wants a bigger model sets it once; every operator pays for a default.
  model: 'claude-sonnet-5',
  effort: 'low',
};

export function getAgentConfig(): AgentConfig {
  // agent-config.json (UI-writable, git-tracked) is the single source of truth for agent settings.
  let config = { ...DEFAULT_CONFIG };
  if (existsSync(CONFIG_PATH)) {
    try { Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))); } catch (e) { console.warn('[claude] failed to parse agent-config.json:', e); }
  }
  return config;
}

export function saveAgentConfig(config: AgentConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  dataSync.trackWrite('agent-config.json');
}

// ── WS events ───────────────────────────────────────────────────────────────

export type WsEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown }
  | { type: 'tool_use_input'; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string }
  | { type: 'tool_result_image'; toolUseId: string; dataUrl: string }
  | { type: 'permission_request'; id: string; tool: string; input: Record<string, unknown> }
  | { type: 'question_request'; id: string; questions: AskQuestion[] }
  | { type: 'thinking_delta'; text: string }
  | { type: 'done'; sessionId: string; stopReason?: 'end_turn' | 'max_turns_reached' | (string & {}); builtinHandled?: boolean }
  | { type: 'model_resolved'; sessionId: string; model: string }
  | { type: 'error'; message: string }
  | { type: 'stats'; sample: { t: number; cpu: number; mem: number; load: number } };
// Add-on engines/features emit their OWN events (e.g. a duplex voice brain's `duplex_*`) through the
// object-typed `emitToSession()` bus (session-bus.ts) — NOT this union. So the core names none of them
// here, yet forwards them verbatim to clients. Keep this union the closed set of core-owned events.

// ── Stream chat ─────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 30;
const RECENT_KEEP = 10;

export type PermissionHandler = (id: string, tool: string, input: Record<string, unknown>) => Promise<{ allow: boolean }>;

/** A single question the agent posed via the built-in AskUserQuestion tool. */
export type AskQuestion = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string; preview?: string }[];
};
/** Answers keyed by question text. String for single-select, string[] for multiSelect. */
export type QuestionAnswers = Record<string, string | string[]>;
/**
 * Medium-agnostic handler for AskUserQuestion. Present the questions to a human
 * (web UI, Slack, email, …), collect answers, and return them — they become the
 * tool result. Return null if no human is reachable / dismissed / timed out, in
 * which case the agent proceeds with its own best judgement.
 */
export type QuestionHandler = (id: string, questions: AskQuestion[]) => Promise<QuestionAnswers | null>;

function messagesSinceSummary(conv: ConvMessage[]): number {
  const summaryIdx = conv.findLastIndex((m) =>
    m.blocks.some((b) => b.type === 'summary')
  );
  return summaryIdx >= 0 ? conv.length - summaryIdx - 1 : conv.length;
}

function messagesToText(messages: ConvMessage[]): string {
  return messages.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const texts = m.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .filter(Boolean);
    return texts.length ? `${role}: ${texts.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

async function maybeCompact(sessionId: string, conv: ConvMessage[]): Promise<void> {
  const sinceLast = messagesSinceSummary(conv);
  if (sinceLast < COMPACT_THRESHOLD) return;

  const summaryIdx = conv.findLastIndex((m) =>
    m.blocks.some((b) => b.type === 'summary')
  );
  const startIdx = summaryIdx >= 0 ? summaryIdx + 1 : 0;
  const toCompact = conv.slice(startIdx, conv.length - RECENT_KEEP);
  if (toCompact.length < RECENT_KEEP) return;

  const existingSummary = summaryIdx >= 0
    ? (conv[summaryIdx].blocks.find((b) => b.type === 'summary') as { type: 'summary'; text: string }).text
    : null;

  const instruction = existingSummary
    ? `Here is an existing conversation summary:\n<existing_summary>\n${existingSummary}\n</existing_summary>\n\nHere are the new messages since that summary. Create an updated, comprehensive summary of the entire conversation so far. Be concise but preserve key facts, decisions, and context. Focus on what matters for continuing the conversation.`
    : `Summarize this conversation concisely. Preserve key facts, decisions, open questions, and context needed to continue the conversation:`;

  try {
    const summaryText = await summarizeText(messagesToText(toCompact), instruction);
    if (!summaryText) return;

    const totalCompacted = (summaryIdx >= 0
      ? (conv[summaryIdx].blocks.find((b) => b.type === 'summary') as { type: 'summary'; text: string; compactedCount: number }).compactedCount
      : 0) + toCompact.length;

    const summaryMsg: ConvMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      blocks: [{ type: 'summary', text: summaryText, compactedCount: totalCompacted }],
    };

    const kept = conv.slice(conv.length - RECENT_KEEP);
    const newConv = summaryIdx >= 0
      ? [...conv.slice(0, summaryIdx), summaryMsg, ...kept]
      : [summaryMsg, ...kept];

    saveConversation(sessionId, newConv);
    conv.length = 0;
    conv.push(...newConv);
    console.log(`[claude] Compacted ${toCompact.length} messages for ${sessionId.slice(0, 8)} (total compacted: ${totalCompacted})`);
  } catch (err) {
    console.error('[claude] Compaction failed:', err);
  }
}

function applyCompactMarkers(conv: ConvMessage[]): ConvMessage[] {
  const markerIdx = conv.findLastIndex((m) =>
    m.blocks.some((b) => b.type === 'compact_marker')
  );
  if (markerIdx < 0) return conv;
  const marker = conv[markerIdx].blocks.find((b) => b.type === 'compact_marker') as { summary: string };
  const summaryMsg: ConvMessage = {
    id: 'compact-summary',
    role: 'assistant',
    blocks: [{ type: 'text', text: `<conversation_summary>\n${marker.summary}\n</conversation_summary>` }],
  };
  return [summaryMsg, ...conv.slice(markerIdx + 1)];
}

export interface AttachmentMeta { url: string; name: string; mimeType: string; path: string }

export async function* streamChat(opts: {
  prompt: string;
  attachments?: AttachmentMeta[];
  images?: string[];
  sessionId?: string;
  uid: string;
  userEmail?: string;
  userName?: string;
  mcpServers?: McpConfig;
  abortController?: AbortController;
  onPermissionRequest?: PermissionHandler;
  onDestructiveApproval?: PermissionHandler;
  onUserQuestion?: QuestionHandler;
  conversationReset?: boolean;
  /** Opaque per-send bag from the client. Never interpreted here — handed to the turn-context seam,
   * where an add-on's contributor reads its own keys. */
  turnHints?: Record<string, unknown>;
  context?: Record<string, string>;
}): AsyncGenerator<WsEvent> {
  const config = getAgentConfig();
  const { prompt: cleanPrompt, directives: parsed } = parseDirectives(opts.prompt);

  const sessionMeta = opts.sessionId ? getSession(opts.sessionId) : undefined;
  const directives: Directives = { ...sessionMeta?.directives, ...parsed };
  // Pin the resolved runtime shape on the session so reopening it later resumes the
  // exact same engine/model even if global defaults change. Gaps only — stored or
  // inline directives always win.
  if (!directives.engine) directives.engine = resolveEngine(parsed, config);
  if (!directives.model && config.model) directives.model = config.model;
  if (!directives.turns && config.maxTurns) directives.turns = config.maxTurns;
  if (!directives.thinking && config.thinking) directives.thinking = config.thinking;
  if (opts.sessionId && JSON.stringify(directives) !== JSON.stringify(sessionMeta?.directives ?? {})) {
    setSessionDirectives(opts.sessionId, directives);
    console.log(`[claude] Directives: ${JSON.stringify(directives)}`);
    yield { type: 'directives', directives } as any;
  }

  // Built-in /compact command
  const slashCmd = parseSlashCommand(cleanPrompt);
  if (slashCmd?.command === 'compact') {
    console.log('[claude] /compact intercepted — handling as built-in');
    const sessionId = opts.sessionId;
    if (!sessionId) {
      yield { type: 'text_delta', text: 'Nothing to compact — no active session.' };
      yield { type: 'done', sessionId: '', builtinHandled: true } as any;
      return;
    }
    const conv = loadConversation(sessionId);
    const lastMarkerIdx = conv.findLastIndex((m) => m.blocks.some((b) => b.type === 'compact_marker'));
    const toSummarize = conv.slice(lastMarkerIdx >= 0 ? lastMarkerIdx + 1 : 0);
    if (toSummarize.length < 4) {
      yield { type: 'text_delta', text: 'Conversation too short to compact.' };
      yield { type: 'done', sessionId, builtinHandled: true } as any;
      return;
    }
    try {
      const existingSummary = lastMarkerIdx >= 0
        ? (conv[lastMarkerIdx].blocks.find((b) => b.type === 'compact_marker') as { summary: string }).summary
        : null;
      const instruction = existingSummary
        ? `Here is an existing conversation summary:\n<existing_summary>\n${existingSummary}\n</existing_summary>\n\nHere are the new messages since that summary. Create an updated, comprehensive summary of the entire conversation so far. Be concise but preserve key facts, decisions, and context. Output only the summary — no preamble, no questions, no conversational filler.`
        : `Summarize this conversation concisely. Preserve key facts, decisions, open questions, and context needed to continue the conversation. Output only the summary — no preamble, no questions, no conversational filler.`;
      const summaryText = await summarizeText(messagesToText(toSummarize), instruction);
      if (!summaryText) {
        yield { type: 'text_delta', text: 'Failed to generate summary.' };
        yield { type: 'done', sessionId, builtinHandled: true } as any;
        return;
      }
      const prevCompacted = lastMarkerIdx >= 0
        ? (conv[lastMarkerIdx].blocks.find((b) => b.type === 'compact_marker') as { compactedCount: number }).compactedCount
        : 0;
      const compactedCount = prevCompacted + toSummarize.length;
      appendMessage(sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'compact_marker', summary: summaryText, compactedCount }],
      });
      yield { type: 'compact_marker', summary: summaryText, compactedCount, sessionId } as any;
    } catch (err) {
      console.error('[claude] /compact failed:', err);
      yield { type: 'text_delta', text: 'Compaction failed.' };
    }
    yield { type: 'done', sessionId, builtinHandled: true } as any;
    return;
  }

  // Slash command resolution
  let effectivePrompt = cleanPrompt;
  if (slashCmd) {
    const skill = getSkill(slashCmd.command);
    if (skill) {
      const { body } = parseSkillFrontmatter(skill.content);
      effectivePrompt = formatCommandBlock(slashCmd.command, body, slashCmd.args);
      if (skill.meta.model) directives.model = skill.meta.model;
    } else if (opts.mcpServers && slashCmd.command in opts.mcpServers) {
      effectivePrompt = getMcpCommandPrompt(slashCmd.command, slashCmd.args);
    } else {
      yield { type: 'text_delta', text: `Unknown command: /${slashCmd.command}` };
      yield { type: 'done', sessionId: opts.sessionId ?? '' };
      return;
    }
  }

  // Expand @skill + @workspace-file mentions
  const withSkillMentions = expandMentionedSkills(effectivePrompt);
  const withMentions = expandWorkspaceMentions(withSkillMentions);
  const defaultSkills = resolveDefaultSkillsContent();
  const mcpSkills = opts.mcpServers ? buildMcpSkillHintsBlock(Object.keys(opts.mcpServers)) : '';
  const discoveryEnabled = config.skillDiscovery !== false;
  const skillIndex = discoveryEnabled ? buildSkillIndexBlock() : '';
  // Triggered skills are sticky: once matched in a session, they stay injected on every later turn.
  const stickyNames = opts.sessionId ? getSession(opts.sessionId)?.triggeredSkills ?? [] : [];
  const newTriggerNames = discoveryEnabled ? matchTriggeredSkillNames(effectivePrompt, opts.context) : [];
  const triggeredNames = [...new Set([...stickyNames, ...newTriggerNames])];
  const triggeredSkills = skillInjectionBlocks(triggeredNames);
  const workspaceTree = buildWorkspaceContextBlock();
  const contact = opts.userEmail ? contacts.find({ email: opts.userEmail }) : null;
  const userBlock = contacts.formatUserBlock(contact);
  const teamRoster = contacts.formatRoster();
  const userContextBlock = getUserContextBlock(contact);
  const contextBlock = [userBlock, userContextBlock, teamRoster, defaultSkills, triggeredSkills, skillIndex, mcpSkills, workspaceTree].filter(Boolean).join('\n');

  // Load conversation for the engine
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  if (newTriggerNames.length) {
    // Some channels (WS) upsert the session only after streaming — ensure the record exists first.
    // email may be absent on this path (userEmail is optional); keep the value as-is —
    // `as string` asserts the record contract without altering the stored value.
    upsertSession(sessionId, effectivePrompt, { uid: opts.uid, email: opts.userEmail as string, name: opts.userName });
    addTriggeredSkills(sessionId, newTriggerNames);
  }
  let conversation: ConvMessage[] = [];
  if (opts.sessionId) {
    conversation = loadConversation(opts.sessionId);
    if (conversation.length > 0) await maybeCompact(opts.sessionId, conversation);
    conversation = applyCompactMarkers(conversation);
  }

  // Per-turn add-on context: prepend whatever the turn-context seam's contributors return to THIS
  // turn's prompt only (not the cacheable contextBlock, not the persisted user message). The core
  // registers no contributors, so this is a no-op here and the prompt is unchanged.
  let turnPrompt = withMentions;
  const turnContext = collectTurnContext({ sessionId, uid: opts.uid, hints: opts.turnHints });
  if (turnContext) {
    turnPrompt = `${turnContext}\n\n${withMentions}`;
    console.log(`[stream] turn-context injected (${turnContext.length} chars) for session=${sessionId}`);
  }

  // Resolve engine and delegate
  const engine = resolveAndGetEngine(directives as any, config);
  console.log(`[stream] engine=${engine.name} user=${opts.uid} session=${sessionId}`);

  yield* engine.stream({
    prompt: turnPrompt,
    conversation,
    contextBlock,
    attachments: opts.attachments,
    images: opts.images,
    sessionId,
    uid: opts.uid,
    userEmail: opts.userEmail,
    userName: opts.userName,
    mcpServers: opts.mcpServers,
    abortController: opts.abortController,
    onPermissionRequest: opts.onPermissionRequest,
    onDestructiveApproval: opts.onDestructiveApproval,
    onUserQuestion: opts.onUserQuestion,
    turnHints: opts.turnHints,
    conversationReset: opts.conversationReset,
    context: opts.context,
    directives,
    config,
  });
}

export async function consumeStream(stream: AsyncGenerator<WsEvent>, onEvent?: (ev: WsEvent) => void): Promise<ConvBlock[]> {
  let text = '';
  let thinking = '';
  const blocks: ConvBlock[] = [];
  for await (const ev of stream) {
    onEvent?.(ev);
    if (ev.type === 'thinking_delta') {
      thinking += ev.text;
    } else if (ev.type === 'text_delta') {
      if (thinking) { blocks.push({ type: 'thinking', text: thinking }); thinking = ''; }
      text += ev.text;
    } else if (ev.type === 'tool_use') {
      if (thinking) { blocks.push({ type: 'thinking', text: thinking }); thinking = ''; }
      if (text) { blocks.push({ type: 'text', text }); text = ''; }
      blocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
    } else if (ev.type === 'tool_use_input') {
      const existing = blocks.find((b) => b.type === 'tool_use' && b.toolUseId === ev.toolUseId) as any;
      if (existing) existing.input = ev.input;
    } else if (ev.type === 'tool_result') {
      blocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
    } else if (ev.type === 'tool_result_image') {
      blocks.push({ type: 'image', src: ev.dataUrl });
    } else if (ev.type === 'done') {
      break;
    } else if (ev.type === 'error') {
      if (text) { blocks.push({ type: 'text', text }); text = ''; }
      blocks.push({ type: 'error', text: ev.message });
      break;
    }
  }
  if (thinking) blocks.push({ type: 'thinking', text: thinking });
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

