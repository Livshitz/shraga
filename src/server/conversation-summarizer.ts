import { readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { dataPath } from './paths.ts';
import { loadAgents } from './agents.ts';
import { runTextQuery } from './sdk-utils.ts';
import { getAllSessions, loadConversation, type ConvMessage } from './sessions.ts';

const CONV_DIR = dataPath('conversations');
const DEFAULT_MAX_AGE = 0;

export interface SummarizerOptions {
  maxAge?: number;
  minFileSize?: number;
  maxConvos?: number;
  force?: boolean;
}

function getAgent() {
  const agents = loadAgents();
  const agent = agents['summarizer'];
  if (!agent) throw new Error('No "summarizer" agent defined in defaults/agents/ or data/agents/');
  return agent;
}

function getTraceAgent() {
  const agents = loadAgents();
  return agents['trace-extractor'] ?? null;
}

function extractText(messages: ConvMessage[], maxChars = 80_000): string {
  const parts: string[] = [];
  let len = 0;
  for (const m of messages) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    for (const b of m.blocks) {
      if (b.type === 'text' && b.text) {
        const line = `${role}: ${b.text.slice(0, 500)}`;
        parts.push(line);
        len += line.length;
        if (len > maxChars) return parts.join('\n');
      } else if (b.type === 'tool_use') {
        parts.push(`Assistant: (tool: ${b.tool})`);
      }
    }
  }
  return parts.join('\n');
}

async function runSummarizerAgent(text: string): Promise<string> {
  const agent = getAgent();
  return runTextQuery({
    prompt: `Here is a transcript of a conversation between a user and an AI assistant. Write a briefing about what happened in this conversation.\n\n<transcript>\n${text}\n</transcript>`,
    model: agent.model || 'haiku',
    maxTurns: agent.maxTurns || 3,
    systemPrompt: agent.prompt,
  });
}

interface TraceMeta {
  sessionId: string;
  email: string;
  date: string;
  title: string;
  messageCount: number;
}

async function runTraceExtractor(text: string, meta: TraceMeta): Promise<string | null> {
  const agent = getTraceAgent();
  if (!agent) return null;

  const metaBlock = `Metadata:\n  session_id: ${meta.sessionId}\n  user: ${meta.email}\n  date: "${meta.date}"\n  title: "${meta.title}"\n  message_count: ${meta.messageCount}`;

  try {
    return await runTextQuery({
      prompt: `${metaBlock}\n\n<transcript>\n${text}\n</transcript>`,
      model: agent.model || 'haiku',
      maxTurns: 1,
      systemPrompt: agent.prompt,
    });
  } catch (err) {
    console.error(`[summarizer] Trace extraction failed:`, err);
    return null;
  }
}

const TRACE_REQUIRED_FIELDS = ['session_id', 'date', 'outcome'];

function validateAndWriteTrace(raw: string, tracePath: string): boolean {
  try {
    const cleaned = raw.replace(/^```ya?ml\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = YAML.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`[summarizer] Trace not an object`);
      return false;
    }
    for (const field of TRACE_REQUIRED_FIELDS) {
      if (!(field in parsed)) {
        console.warn(`[summarizer] Trace missing required field: ${field}`);
        return false;
      }
    }
    writeFileSync(tracePath, cleaned + '\n');
    return true;
  } catch (err) {
    console.warn(`[summarizer] Trace YAML parse failed:`, err);
    return false;
  }
}

export async function summarizeConversations(options?: SummarizerOptions): Promise<{
  summarized: number;
  skipped: number;
  errors: number;
  tracesGenerated: number;
}> {
  const maxAge = options?.maxAge ?? DEFAULT_MAX_AGE;
  const minFileSize = options?.minFileSize ?? 5_000; // 5KB — filters out trivial "hey/hi" convos
  const maxConvos = options?.maxConvos ?? 20;
  const force = options?.force ?? false;

  const now = Date.now();
  const sessions = getAllSessions();
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]));

  const jsonlFiles = readdirSync(CONV_DIR).filter(f => f.endsWith('.jsonl'));

  const candidates: { sessionId: string; jsonlPath: string; summaryPath: string; jsonlMtime: number }[] = [];

  for (const f of jsonlFiles) {
    const sessionId = f.slice(0, -6);
    const jsonlPath = path.join(CONV_DIR, f);
    const summaryPath = path.join(CONV_DIR, `${sessionId}.summary.md`);
    const stat = statSync(jsonlPath);
    const jsonlMtime = stat.mtimeMs;

    if (now - jsonlMtime < maxAge) continue;
    if (stat.size < minFileSize) continue;

    if (!force && existsSync(summaryPath)) {
      const summaryMtime = statSync(summaryPath).mtimeMs;
      if (summaryMtime >= jsonlMtime) continue;
    }

    candidates.push({ sessionId, jsonlPath, summaryPath, jsonlMtime });
  }

  candidates.sort((a, b) => a.jsonlMtime - b.jsonlMtime);
  const batch = candidates.slice(0, maxConvos);

  let summarized = 0;
  let skipped = 0;
  let errors = 0;
  let tracesGenerated = 0;

  for (const { sessionId, jsonlPath, summaryPath, jsonlMtime } of batch) {
    try {
      const messages = loadConversation(sessionId);
      const text = extractText(messages);
      if (!text.trim()) {
        skipped++;
        continue;
      }

      const session = sessionMap.get(sessionId);
      const title = session?.title || '(untitled)';
      const email = session?.userEmail || 'unknown';
      const date = new Date(session?.lastModified ?? Date.now()).toISOString().slice(0, 10);

      console.log(`[summarizer] Summarizing ${sessionId.slice(0, 8)}... (${messages.length} msgs)`);
      const summary = await runSummarizerAgent(text);

      if (!summary?.trim()) {
        console.warn(`[summarizer] Empty summary for ${sessionId.slice(0, 8)}`);
        skipped++;
        continue;
      }

      const content = `<!-- session: ${sessionId} | user: ${email} | date: ${date} | title: ${title} -->\n\n${summary}\n`;
      writeFileSync(summaryPath, content);
      summarized++;
      console.log(`[summarizer] Done ${sessionId.slice(0, 8)} (${summary.length} chars)`);

      // Trace extraction (second pass)
      const tracePath = path.join(CONV_DIR, `${sessionId}.trace.yaml`);
      const traceUpToDate = !force && existsSync(tracePath) && statSync(tracePath).mtimeMs >= jsonlMtime;

      if (!traceUpToDate) {
        const traceMeta: TraceMeta = { sessionId, email, date, title, messageCount: messages.length };
        const traceRaw = await runTraceExtractor(text, traceMeta);
        if (traceRaw && validateAndWriteTrace(traceRaw, tracePath)) {
          tracesGenerated++;
          console.log(`[summarizer] Trace written for ${sessionId.slice(0, 8)}`);
        }
      }
    } catch (err) {
      console.error(`[summarizer] Error on ${sessionId.slice(0, 8)}:`, err);
      errors++;
    }
  }

  console.log(`[summarizer] Finished: ${summarized} summarized, ${tracesGenerated} traces, ${skipped} skipped, ${errors} errors (${candidates.length - batch.length} deferred)`);
  return { summarized, skipped, errors, tracesGenerated };
}
