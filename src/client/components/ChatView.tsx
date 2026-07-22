import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Root, Element } from 'hast';
import type { Plugin } from 'unified';

const RTL_BLOCK_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th']);
const rehypeBidi: Plugin<[], Root> = () => (tree) => {
  const visit = (node: Root | Element) => {
    for (const child of (node.children ?? [])) {
      if (child.type === 'element') {
        if (RTL_BLOCK_TAGS.has(child.tagName)) {
          child.properties ??= {};
          child.properties.dir = 'auto';
        }
        visit(child);
      }
    }
  };
  visit(tree);
};
import 'highlight.js/styles/github.css';
import { ChevronRight, Wrench, User, Bot, Copy, Check, RotateCcw, Pencil, X, SendHorizontal, ShieldQuestion, CheckCircle2, XCircle, Eye, EyeOff, Info, Loader2, BrainCircuit, GitFork, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage, MessageBlock, Attachment } from '@/hooks/useConversation';
import type { AskQuestion, QuestionAnswers } from '@/lib/ws';
import { SmartChart, tryParseChartData } from './SmartChart';
import { AuthedImage, AuthedFileLink } from './AuthedImage';
import { useSlots } from '@/lib/slots';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ZoomableImage } from './ZoomableImage';

// The appwrap iOS WKWebView wedges its GPU compositor when rendering react-markdown's DOM for a chat with
// history — JS keeps running but paint + hit-testing freeze for ~1-2min (screen stuck/touch-dead) before
// WebKit lazily restores. The SAME content in mobile Safari and on desktop is fine, so this is specific to
// the native WKWebView shell, not the web app. Until the native shell issue is fixed, render assistant
// messages as PLAIN TEXT inside the native app only; full markdown stays on Safari/desktop/web.
const IS_APPWRAP_NATIVE = typeof window !== 'undefined' && !!(window as { webkit?: { messageHandlers?: { appwrap?: unknown } } }).webkit?.messageHandlers?.appwrap;

function AssistantMarkdown({ text, onImageClick }: { text: string; onImageClick?: (src: string) => void }) {
  const clean = text.replace(/\[Image #\d+\]\s*/g, '').trim();
  if (IS_APPWRAP_NATIVE) {
    return <div className="prose prose-sm max-w-none dark:prose-invert break-words min-w-0 whitespace-pre-wrap">{clean}</div>;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, rehypeBidi]}
      className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:border prose-code:before:content-none prose-code:after:content-none break-words min-w-0"
      components={{
        pre: ({ children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        img: ({ src, alt }) => <AuthedImage src={src ?? ''} alt={alt ?? ''} className="max-h-[80vh] max-w-full rounded-xl border object-contain cursor-pointer hover:opacity-80 transition-opacity" onClick={(s) => onImageClick?.(s)} />,
      }}
    >{clean}</ReactMarkdown>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(!sameYear && { year: 'numeric' }) });
  return `${date}, ${time}`;
}

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  connectionStatus?: 'disconnected' | 'reconnected' | 'update_available' | 'server_restarting' | null;
  onPermissionRespond?: (id: string, allow: boolean, allowAll?: boolean) => void;
  onQuestionRespond?: (id: string, answers: QuestionAnswers) => void;
  onReplay?: (messageId: string, text: string, attachments?: Attachment[]) => void;
  onEdit?: (messageId: string, text: string, attachments?: Attachment[]) => void;
  onFork?: (messageIndex: number) => void;
  multiParticipant?: boolean;
  /** Opaque add-on status items — rendered inline at the bottom of the thread via the statusChips slot. */
  statusItems?: unknown[];
}

const SHOW_DETAILS_KEY = 'shraga:showDetails';

export function ChatView({ messages, busy, connectionStatus, onPermissionRespond, onQuestionRespond, onReplay, onEdit, onFork, multiParticipant, statusItems }: Props) {
  const slots = useSlots();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const [showDetails, setShowDetails] = useState(() => localStorage.getItem(SHOW_DETAILS_KEY) === 'true');
  const [lightbox, setLightbox] = useState<string | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const screenMap = useMemo(() => buildScreenMap(messages), [messages]);

  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, busy]);

  if (messages.length === 0 && !busy) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3 max-w-md px-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <Bot className="w-6 h-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">How can I help?</h2>
          <p className="text-sm text-muted-foreground">
            I can read files, edit code, run commands, search the web, and use any configured MCP tools on the remote machine.
          </p>
        </div>
      </div>
    );
  }

  const toggleDetails = () => {
    setShowDetails((v) => {
      localStorage.setItem(SHOW_DETAILS_KEY, String(!v));
      return !v;
    });
  };

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-3xl mx-auto px-2 sm:px-4 py-4 sm:py-6 space-y-1">
        <div className="flex justify-end mb-2">
          <button onClick={toggleDetails} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title={showDetails ? 'Hide tool details' : 'Show tool details'}>
            {showDetails ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Details
          </button>
        </div>
        {messages.map((msg, idx) => (
          <MessageRow key={msg.id} message={msg} messageIndex={idx} isLast={idx === messages.length - 1} showDetails={showDetails} onPermissionRespond={onPermissionRespond} onQuestionRespond={onQuestionRespond} onReplay={onReplay} onEdit={onEdit} onFork={onFork} onImageClick={setLightbox} busy={busy && idx === messages.length - 1} screenMap={screenMap} multiParticipant={multiParticipant} />
        ))}

        {busy && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex gap-3 py-4">
            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        )}

        {!!statusItems?.length && slots.statusChips && (
          <div className="flex gap-3 py-2">
            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0 pt-1">{slots.statusChips(statusItems)}</div>
          </div>
        )}

        {connectionStatus && connectionStatus !== 'update_available' && (
          <div className={cn(
            'text-center text-xs py-1.5 rounded-md transition-opacity',
            connectionStatus === 'reconnected' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
          )}>
            {connectionStatus === 'server_restarting' ? 'Server updating — reconnecting automatically…'
              : connectionStatus === 'disconnected' ? 'Connection lost — reconnecting...'
              : 'Reconnected.'}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
      <Dialog open={!!lightbox} onOpenChange={(o) => { if (!o) setLightbox(null); }}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] w-[90vw] h-[90vh] p-2 flex items-center justify-center bg-background/95">
          {lightbox && <ZoomableImage src={lightbox} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MessageRow({
  message,
  messageIndex,
  isLast,
  showDetails,
  onPermissionRespond,
  onQuestionRespond,
  onReplay,
  onEdit,
  onFork,
  onImageClick,
  busy,
  screenMap,
  multiParticipant,
}: {
  message: ChatMessage;
  messageIndex: number;
  isLast: boolean;
  showDetails: boolean;
  onPermissionRespond?: (id: string, allow: boolean, allowAll?: boolean) => void;
  onQuestionRespond?: (id: string, answers: QuestionAnswers) => void;
  onReplay?: (messageId: string, text: string, attachments?: Attachment[]) => void;
  onEdit?: (messageId: string, text: string, attachments?: Attachment[]) => void;
  onFork?: (messageIndex: number) => void;
  onImageClick?: (src: string) => void;
  busy?: boolean;
  screenMap?: Map<string, string[]>;
  multiParticipant?: boolean;
}) {
  const compactBlock = message.blocks.find((b) => b.type === 'compact_marker');
  if (compactBlock && compactBlock.type === 'compact_marker') {
    return <CompactMarkerDivider summary={compactBlock.summary} compactedCount={compactBlock.compactedCount} />;
  }

  const isUser = message.role === 'user';
  const userText = isUser
    ? message.blocks.find((b) => b.type === 'text')?.text ?? ''
    : '';
  const userAttachments: Attachment[] | undefined = isUser
    ? message.blocks
        .filter((b): b is MessageBlock & { type: 'image' | 'file' } => b.type === 'image' || b.type === 'file')
        .map((b) => b.type === 'image'
          ? { url: b.src, name: b.src.split('/').pop() ?? 'image', mimeType: 'image/png', path: b.src }
          : { url: b.src, name: b.name, mimeType: b.mimeType, path: b.src })
    : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [actionsVisible, setActionsVisible] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(userText);
    setEditing(true);
    setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  };

  const submitEdit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setEditing(false);
    onEdit?.(message.id, trimmed, userAttachments?.length ? userAttachments : undefined);
  };

  return (
    <div
      className={cn('flex gap-3 py-4 group/row', isUser && 'flex-row-reverse')}
      onTouchStart={(e) => { if (!(e.target as HTMLElement).closest('button')) setActionsVisible((v) => !v); }}
    >
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-4 h-4 text-muted-foreground" />
        </div>
      )}

      <div className={cn('min-w-0 max-w-[92%] sm:max-w-[85%] space-y-2')}>
        {multiParticipant && isUser && message.senderName && (
          <div className="text-[11px] font-medium text-muted-foreground text-right px-1">{message.senderName}</div>
        )}
        {editing ? (
          <div className="inline-block text-left w-full">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full rounded-xl border bg-muted/50 px-4 py-2.5 text-sm resize-none outline-none focus:ring-1 focus:ring-primary min-h-[40px]"
            />
            <div className="flex gap-1 justify-end mt-1">
              <button onClick={() => setEditing(false)} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Cancel">
                <X className="w-3.5 h-3.5" />
              </button>
              <button onClick={submitEdit} className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors" title="Send">
                <SendHorizontal className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <>
        {message.blocks
          .filter((b) => {
            if (showDetails) return true;
            if (b.type === 'tool_use' && b.tool === 'AskUserQuestion') {
              return message.blocks.some((r) => r.type === 'tool_result' && r.toolUseId === b.toolUseId);
            }
            return b.type !== 'tool_use' && b.type !== 'tool_result' && b.type !== 'thinking';
          })
          .filter((b) => {
            if (b.type !== 'tool_result') return true;
            return !message.blocks.some((u) => u.type === 'tool_use' && u.toolUseId === b.toolUseId);
          })
          .map((block, i, arr) => {
            const result = block.type === 'tool_use'
              ? message.blocks.find((b): b is MessageBlock & { type: 'tool_result' } => b.type === 'tool_result' && b.toolUseId === block.toolUseId)
              : undefined;
            return <BlockRenderer key={i} block={block} isUser={isUser} onPermissionRespond={onPermissionRespond} onQuestionRespond={onQuestionRespond} pairedResult={result} onImageClick={onImageClick} busy={busy} screenMap={screenMap} />;
          })}
            {isUser && userText && (
              <div className={cn('flex gap-1 items-center justify-end transition-opacity', actionsVisible ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100')}>
                {message.ts && <span className="text-[10px] text-muted-foreground/50 select-none mr-1">{formatTs(message.ts)}</span>}
                <button
                  onClick={() => onReplay?.(message.id, userText, userAttachments?.length ? userAttachments : undefined)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Replay"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={startEdit}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Edit & resend"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {!isUser && !(busy && isLast) && (
              <div className={cn('flex gap-1 items-center transition-opacity', actionsVisible ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100')}>
                {message.ts && <span className="text-[10px] text-muted-foreground/40 select-none mr-1">{formatTs(message.ts)}</span>}
                <button
                  onClick={() => onFork?.(messageIndex)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Fork from here"
                >
                  <GitFork className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CompactMarkerDivider({ summary, compactedCount }: { summary: string; compactedCount: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-amber-500/30" />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
        >
          <Minimize2 className="w-3 h-3" />
          Compacted · {compactedCount} messages
          <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
        </button>
        <div className="flex-1 border-t border-amber-500/30" />
      </div>
      {expanded && (
        <div className="mt-2 mx-auto max-w-2xl px-4 py-3 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs text-muted-foreground whitespace-pre-wrap">
          {summary}
        </div>
      )}
    </div>
  );
}

function BlockRenderer({ block, isUser, onPermissionRespond, onQuestionRespond, pairedResult, onImageClick, busy, screenMap }: { block: MessageBlock; isUser: boolean; onPermissionRespond?: (id: string, allow: boolean, allowAll?: boolean) => void; onQuestionRespond?: (id: string, answers: QuestionAnswers) => void; pairedResult?: MessageBlock & { type: 'tool_result' }; onImageClick?: (src: string) => void; busy?: boolean; screenMap?: Map<string, string[]> }) {
  const slots = useSlots();
  if (block.type === 'image') {
    return (
      <AuthedImage src={block.src} className="max-h-[80vh] max-w-full rounded-xl border object-contain cursor-pointer hover:opacity-80 transition-opacity" onClick={(s) => onImageClick?.(s)} />
    );
  }

  if (block.type === 'file') {
    return (
      <div>
        <AuthedFileLink src={block.src} name={block.name} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted/50 text-sm text-muted-foreground hover:bg-muted transition-colors" />
      </div>
    );
  }

  if (block.type === 'context') {
    return <ContextBlock label={block.label} text={block.text} />;
  }

  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.text} />;
  }

  if (block.type === 'error') {
    return <ErrorBlock text={block.text} />;
  }

  if (block.type === 'text') {
    if (isUser) {
      return (
        <div dir="auto" className="inline-block bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm break-words min-w-0 max-w-full whitespace-pre-wrap">
          {block.text}
        </div>
      );
    }
    return (
      <div className="text-sm" dir="auto">
        <AssistantMarkdown text={block.text} onImageClick={onImageClick} />
      </div>
    );
  }

  if (block.type === 'tool_use') {
    if (block.tool === 'AskUserQuestion' && pairedResult?.output) {
      return <AskUserQuestionSummary input={block.input} result={pairedResult.output} />;
    }
    return <ToolUseBlock block={block} tool={block.tool} input={block.input} result={pairedResult?.output} busy={busy} screenMap={screenMap} />;
  }

  if (block.type === 'tool_result') {
    return <ToolResultBlock output={block.output} />;
  }

  if (block.type === 'permission_request') {
    return <PermissionRequestBlock id={block.id} tool={block.tool} input={block.input} onRespond={onPermissionRespond} />;
  }

  if (block.type === 'question_request') {
    return <QuestionRequestBlock id={block.id} questions={block.questions} onRespond={onQuestionRespond} />;
  }

  // Non-core (extension) block type — the core renders nothing itself; an add-on slot may.
  return slots.extensionBlocks?.({ block, onImageClick }) ?? null;
}

/** A run that failed at the engine/adapter level — deliberately loud, never mistakable for a reply. */
function ErrorBlock({ text }: { text: string }) {
  return (
    <div dir="auto" className="border border-destructive/40 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive break-words">
      <span className="font-medium">⚠️ Run failed</span>
      <div className="mt-1 text-xs opacity-90 whitespace-pre-wrap font-mono">{text}</div>
    </div>
  );
}

function ContextBlock({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-blue-500/20 rounded-lg overflow-hidden text-xs bg-blue-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-3 py-2 hover:bg-blue-500/10 transition-colors text-left"
      >
        <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        <span className="text-blue-300 font-medium">{label}</span>
        <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ml-auto', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-blue-500/20 text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.slice(0, 120).replace(/\n/g, ' ');
  return (
    <div className="border border-violet-500/20 rounded-lg overflow-hidden text-xs bg-violet-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-3 py-2 hover:bg-violet-500/10 transition-colors text-left"
      >
        <BrainCircuit className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-violet-300 font-medium">Thinking</span>
        <span className="text-muted-foreground truncate">{preview}</span>
        <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ml-auto', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-violet-500/20 text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function buildScreenMap(messages: ChatMessage[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type !== 'tool_result' || !block.output) continue;
      try {
        const parsed = JSON.parse(block.output);
        if (typeof parsed?.sessionId === 'string' && Array.isArray(parsed?.screen)) {
          map.set(parsed.sessionId, parsed.screen);
        }
      } catch {}
    }
  }
  return map;
}

function parseAnswersFromResult(result: string): Record<string, string> {
  const answers: Record<string, string> = {};
  const re = /"([^"]+)"="([^"]+)"/g;
  let match;
  while ((match = re.exec(result)) !== null) {
    answers[match[1]] = match[2];
  }
  return answers;
}

function AskUserQuestionSummary({ input, result }: { input: unknown; result: string }) {
  const data = input as { questions?: Array<{ question: string; header?: string }> };
  const questions = data?.questions ?? [];
  const answers = parseAnswersFromResult(result);
  if (!questions.length || !Object.keys(answers).length) return null;

  return (
    <div className="border rounded-lg overflow-hidden text-xs bg-blue-500/5 border-blue-500/20">
      <div className="flex items-center gap-1.5 px-2 sm:px-3 py-2 bg-blue-50 dark:bg-blue-950/40">
        <ShieldQuestion className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        <span className="font-medium text-blue-300">Questions answered</span>
      </div>
      <div className="px-2 sm:px-3 py-2 space-y-2">
        {questions.map((q, i) => {
          const answer = answers[q.question];
          if (!answer) return null;
          return (
            <div key={i} className="space-y-0.5">
              <div className="text-muted-foreground">{q.header ? `${q.header}: ` : ''}{q.question}</div>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
                <Check className="w-2.5 h-2.5" />{answer}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolUseBlock({ block, tool, input, result, busy, screenMap }: { block: MessageBlock; tool: string; input: unknown; result?: string; busy?: boolean; screenMap?: Map<string, string[]> }) {
  const slots = useSlots();
  const [expanded, setExpanded] = useState(false);
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const isEmpty = typeof input === 'object' && input !== null && Object.keys(input as object).length === 0;
  const preview = isEmpty
    ? ''
    : typeof input === 'object' && input !== null
      ? Object.keys(input as object).join(', ')
      : String(input).slice(0, 60);

  const resultTrimmed = result != null ? stripLineNumbers(result.trim().replace(/\[Image #\d+\]\s*/g, '').trim()) : undefined;
  const hasResult = result != null;
  const isError = resultTrimmed ? /^(Error|ERROR)|"status"\s*:\s*[45]\d\d|ENOENT|EACCES|Permission denied|command not found|No such file/i.test(resultTrimmed) : false;
  const statusIcon = hasResult
    ? isError ? <XCircle className="w-3 h-3 text-red-400 shrink-0" /> : <Check className="w-3 h-3 text-green-400 shrink-0" />
    : null;

  return (
    <div className="text-xs min-w-0 space-y-2">
      <div className="border rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2 sm:px-3 py-2 bg-muted/50 hover:bg-muted transition-colors text-left min-w-0"
        >
          <Wrench className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium text-foreground shrink-0">{tool}</span>
          {!isEmpty && <span className="text-muted-foreground truncate min-w-0">{preview}</span>}
          {hasResult ? statusIcon : busy ? <Loader2 className="w-3 h-3 text-muted-foreground animate-spin shrink-0" /> : <span title="Interrupted"><XCircle className="w-3 h-3 text-amber-400 shrink-0" /></span>}
          <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ml-auto', expanded && 'rotate-90')} />
        </button>
        {expanded && (
          <div className="border-t">
            {!isEmpty && (
              <pre className="p-3 overflow-auto max-h-64 text-xs bg-background whitespace-pre-wrap break-all">
                {inputStr}
              </pre>
            )}
            {resultTrimmed && (
              <pre className={cn('p-3 overflow-auto max-h-64 text-xs whitespace-pre-wrap break-words', !isEmpty && 'border-t', isError ? 'bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300' : 'bg-muted/30 text-foreground/80')}>
                {resultTrimmed}
              </pre>
            )}
          </div>
        )}
      </div>
      {slots.toolRenderers?.({ block, result, screens: screenMap })}
    </div>
  );
}

/** Strip cat -n line-number prefixes (e.g. "  1\tcode here") */
function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 2) return text;
  const numbered = lines.filter(l => l.length > 0).every(l => /^\s*\d+\t/.test(l));
  if (!numbered) return text;
  return lines.map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
}

function ToolResultBlock({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = output.trim().replace(/\[Image #\d+\]\s*/g, '').trim();
  const trimmed = stripLineNumbers(cleaned);

  if (!trimmed) return null;

  const isError = /^(Error|ERROR)|"status"\s*:\s*[45]\d\d|ENOENT|EACCES|Permission denied|command not found|No such file/i.test(trimmed);
  const chartData = !isError ? tryParseChartData(trimmed) : null;
  const isLong = trimmed.length > 200;
  const preview = trimmed.slice(0, 120).replace(/\n/g, ' ');

  const Icon = isError ? XCircle : Check;
  const borderCls = isError ? 'border-red-200 dark:border-red-900' : 'border-green-200 dark:border-green-900';
  const bgCls = isError
    ? 'bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50'
    : 'bg-green-50 dark:bg-green-950/30 hover:bg-green-100 dark:hover:bg-green-950/50';
  const iconCls = isError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400';

  return (
    <div className={cn('border rounded-lg overflow-hidden text-xs min-w-0', borderCls)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn('flex items-center gap-1.5 w-full px-2 sm:px-3 py-2 transition-colors text-left min-w-0', bgCls)}
      >
        <Icon className={cn('w-3.5 h-3.5 shrink-0', iconCls)} />
        <span className="text-muted-foreground truncate flex-1 min-w-0">{isLong ? preview + '…' : preview}</span>
        <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="p-3 bg-background border-t">
          {chartData ? <SmartChart data={chartData} /> : (
            <pre className="overflow-auto max-h-96 text-xs whitespace-pre-wrap break-words">{trimmed}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionRequestBlock({
  id,
  tool,
  input,
  onRespond,
}: {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  onRespond?: (id: string, allow: boolean, allowAll?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(input, null, 2);
  const preview = Object.keys(input).join(', ');

  return (
    <div className="border-2 rounded-lg overflow-hidden text-xs border-amber-300 dark:border-amber-700 animate-in fade-in slide-in-from-bottom-2 min-w-0">
      <div className="flex items-center gap-1.5 px-2 sm:px-3 py-2 bg-amber-50 dark:bg-amber-950/40 min-w-0">
        <ShieldQuestion className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="font-medium text-foreground shrink-0">{tool}</span>
        <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground truncate min-w-0 text-left hover:text-foreground transition-colors">
          {preview}
          <ChevronRight className={cn('w-3.5 h-3.5 inline ml-1 transition-transform', expanded && 'rotate-90')} />
        </button>
      </div>
      {expanded && (
        <pre className="p-3 overflow-auto max-h-48 text-xs bg-background border-t border-amber-200 dark:border-amber-800 whitespace-pre-wrap break-all">
          {inputStr}
        </pre>
      )}
      <div className="flex flex-wrap gap-2 px-2 sm:px-3 py-2 bg-amber-50/50 dark:bg-amber-950/20 border-t border-amber-200 dark:border-amber-800">
        <button
          onClick={() => onRespond?.(id, true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Allow
        </button>
        <button
          onClick={() => onRespond?.(id, true, true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Always Allow
        </button>
        <button
          onClick={() => onRespond?.(id, false)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
        >
          <XCircle className="w-3.5 h-3.5" />
          Deny
        </button>
      </div>
    </div>
  );
}

function QuestionRequestBlock({
  id,
  questions,
  onRespond,
}: {
  id: string;
  questions: AskQuestion[];
  onRespond?: (id: string, answers: QuestionAnswers) => void;
}) {
  // selections[qIdx] = Set of chosen labels; "other" free-text kept separately.
  const [selections, setSelections] = useState<Record<number, Set<string>>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const slots = useSlots();

  // Reflect externally-supplied answers into the card as they arrive (add-on slot; no-op in core).
  useEffect(() => {
    return slots.onCardInteraction?.({
      id,
      questions,
      onAnswers: (answers) => {
        setSelections(() => {
          const next: Record<number, Set<string>> = {};
          questions.forEach((q, i) => {
            const a = answers[q.question];
            if (a == null) return;
            next[i] = new Set(Array.isArray(a) ? a : [a]);
          });
          return next;
        });
      },
    });
  }, [id, questions, slots]);

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = new Set(prev[qIdx] ?? []);
      if (multi) { cur.has(label) ? cur.delete(label) : cur.add(label); }
      else { cur.clear(); cur.add(label); }
      return { ...prev, [qIdx]: cur };
    });
  };

  const OTHER = '__other__';
  const answeredCount = questions.filter((q, i) => {
    const sel = selections[i];
    if (!sel || sel.size === 0) return false;
    if (sel.has(OTHER) && !other[i]?.trim()) return false;
    return true;
  }).length;
  const ready = answeredCount === questions.length;

  const submit = () => {
    if (!ready || submitted) return;
    const answers: QuestionAnswers = {};
    questions.forEach((q, i) => {
      const labels = [...(selections[i] ?? [])].map((l) => (l === OTHER ? other[i].trim() : l));
      answers[q.question] = q.multiSelect ? labels : labels[0];
    });
    setSubmitted(true);
    onRespond?.(id, answers);
  };

  return (
    <div className="border-2 rounded-lg overflow-hidden text-xs border-blue-300 dark:border-blue-700 animate-in fade-in slide-in-from-bottom-2 min-w-0">
      <div className="flex items-center gap-1.5 px-2 sm:px-3 py-2 bg-blue-50 dark:bg-blue-950/40">
        <ShieldQuestion className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
        <span className="font-medium text-foreground">Questions for you</span>
      </div>
      <div className="px-2 sm:px-3 py-2 space-y-4 bg-background">
        {questions.map((q, i) => {
          const multi = !!q.multiSelect;
          const sel = selections[i] ?? new Set<string>();
          return (
            <div key={i} className="space-y-1.5">
              <div className="font-medium text-foreground">{q.question}</div>
              <div className="space-y-1">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    disabled={submitted}
                    onClick={() => toggle(i, opt.label, multi)}
                    className={cn(
                      'flex items-start gap-2 w-full text-left px-2 py-1.5 rounded-md border transition-colors',
                      sel.has(opt.label)
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <span className={cn('mt-0.5 w-3.5 h-3.5 shrink-0 border flex items-center justify-center', multi ? 'rounded-sm' : 'rounded-full', sel.has(opt.label) ? 'bg-blue-500 border-blue-500' : 'border-muted-foreground')}>
                      {sel.has(opt.label) && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{opt.label}</span>
                      {opt.description && <span className="text-muted-foreground"> — {opt.description}</span>}
                    </span>
                  </button>
                ))}
                <div className={cn('flex items-center gap-2 px-2 py-1.5 rounded-md border', sel.has(OTHER) ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40' : 'border-border')}>
                  <button disabled={submitted} onClick={() => toggle(i, OTHER, multi)} className={cn('w-3.5 h-3.5 shrink-0 border flex items-center justify-center', multi ? 'rounded-sm' : 'rounded-full', sel.has(OTHER) ? 'bg-blue-500 border-blue-500' : 'border-muted-foreground')}>
                    {sel.has(OTHER) && <Check className="w-2.5 h-2.5 text-white" />}
                  </button>
                  <input
                    type="text"
                    disabled={submitted}
                    value={other[i] ?? ''}
                    placeholder="Other…"
                    onChange={(e) => { setOther((p) => ({ ...p, [i]: e.target.value })); if (e.target.value && !sel.has(OTHER)) toggle(i, OTHER, multi); }}
                    className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-2 sm:px-3 py-2 bg-blue-50/50 dark:bg-blue-950/20 border-t border-blue-200 dark:border-blue-800">
        <button
          onClick={submit}
          disabled={!ready || submitted}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <SendHorizontal className="w-3.5 h-3.5" />
          {submitted ? 'Sent' : 'Submit'}
        </button>
        <span className="text-muted-foreground">{answeredCount}/{questions.length} answered</span>
      </div>
    </div>
  );
}

function CodeBlock({ children, ...props }: any) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="relative group">
      <pre ref={ref} {...props} className="rounded-lg border bg-muted p-4 overflow-x-auto text-xs text-foreground">
        {children}
      </pre>
      <CopyButton getText={() => ref.current?.textContent || ''} />
    </div>
  );
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 border opacity-0 group-hover:opacity-100 transition-opacity"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}
