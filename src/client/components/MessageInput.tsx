import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { SendHorizontal, Paperclip, X, Square, FileText } from 'lucide-react';
import { Button } from './ui/button';
import { AutocompleteTextarea, type AutocompleteTextareaHandle } from './AutocompleteTextarea';
import { AuthedImage } from './AuthedImage';
import { useSlots } from '@/lib/slots';
import type { Attachment } from '@/hooks/useConversation';

export interface MessageInputHandle {
  prefill: (text: string) => void;
  /** Set the input text without stealing focus (used for live external transcription). */
  setText: (text: string) => void;
  focus: () => void;
}

const DRAFT_PREFIX = 'shraga:draft:';

function saveDraft(sessionId: string | undefined, text: string) {
  const key = DRAFT_PREFIX + (sessionId ?? 'new');
  if (text.trim()) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
}

function loadDraft(sessionId: string | undefined): string {
  return localStorage.getItem(DRAFT_PREFIX + (sessionId ?? 'new')) ?? '';
}

function clearDraft(sessionId: string | undefined) {
  localStorage.removeItem(DRAFT_PREFIX + (sessionId ?? 'new'));
}

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onSteer: (text: string) => void;
  onQueue: (text: string) => void;
  onRemoveQueued: (index: number) => void;
  queue: string[];
  onUpload: (file: File) => Promise<Attachment | null>;
  onCancel: () => void;
  disabled?: boolean;
  busy?: boolean;
  skills?: string[];
  workspaceFiles?: string[];
  sessionId?: string;
  /** Opaque per-pane handle passed straight through to the inputAdornments slot; unused in core. */
  inputCtx?: unknown;
}

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput(
  { onSend, onSteer, onQueue, onRemoveQueued, queue, onUpload, onCancel, disabled, busy, skills = [], workspaceFiles = [], sessionId, inputCtx },
  ref,
) {
  const slots = useSlots();
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<AutocompleteTextareaHandle>(null);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (sessionIdRef.current === sessionId) return;
    const prevId = sessionIdRef.current;
    sessionIdRef.current = sessionId;
    // New chat: carry current draft forward instead of saving to old session
    if (!sessionId) {
      clearDraft(prevId);
      saveDraft(undefined, text);
      return;
    }
    saveDraft(prevId, text);
    const restored = loadDraft(sessionId);
    setText(restored);
    acRef.current?.setValue(restored);
  }, [sessionId]);

  const setTextAndSave = useCallback((value: string) => {
    setText(value);
    saveDraft(sessionIdRef.current, value);
  }, []);

  useImperativeHandle(ref, () => ({
    prefill(value: string) {
      setTextAndSave(value);
      acRef.current?.setValue(value);
      acRef.current?.focus();
    },
    setText(value: string) {
      setTextAndSave(value);
      acRef.current?.setValue(value);
    },
    focus() {
      acRef.current?.focus();
    },
  }));

  const submit = (mode: 'send' | 'steer' | 'queue' = 'send') => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (mode === 'steer') onSteer(trimmed);
    else if (mode === 'queue') onQueue(trimmed);
    else onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText('');
    clearDraft(sessionIdRef.current);
    setAttachments([]);
    acRef.current?.setValue('');
  };

  // Mobile = coarse primary pointer (phone/tablet). Touchscreen laptops keep a fine pointer, so Enter still submits there.
  const isTouchDevice = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && (!isTouchDevice || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(busy ? 'steer' : 'send');
      return;
    }
    if (e.key === 'Tab' && busy && text.trim()) {
      e.preventDefault();
      submit('queue');
      return;
    }
  };

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const att = await onUpload(file);
      if (att) setAttachments((prev) => [...prev, att]);
    } finally {
      setUploading(false);
    }
  }, [onUpload]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/') || item.type === 'application/pdf') {
        const file = item.getAsFile();
        if (file) uploadFile(file);
      }
    }
  }, [uploadFile]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadFile(file);
    e.target.value = '';
  };

  return (
    // paddingBottom: the input's own background continues into the iOS home-indicator strip (no-op on web).
    <div className="border-t bg-background" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-3xl mx-auto px-2 sm:px-4 py-3">
        {(attachments.length > 0 || uploading) && (
          <div className="flex gap-2 mb-2 flex-wrap items-center">
            {attachments.map((att, i) => (
              <div key={i} className="relative group">
                {att.mimeType.startsWith('image/') ? (
                  <AuthedImage src={att.url} alt={att.name} className="h-16 w-16 object-cover rounded-lg border" />
                ) : (
                  <div className="h-16 px-3 flex items-center gap-2 rounded-lg border bg-muted/50 text-xs text-muted-foreground">
                    <FileText className="w-4 h-4 shrink-0" />
                    <span className="truncate max-w-[120px]">{att.name}</span>
                  </div>
                )}
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploading && <span className="text-xs text-muted-foreground animate-pulse">Uploading…</span>}
          </div>
        )}

        <div className="flex items-center gap-2 bg-muted/50 rounded-xl border px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 sm:h-8 sm:w-8 shrink-0"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            title="Attach file or image"
          >
            <Paperclip className="w-4 h-4" />
          </Button>
          <input ref={fileRef} type="file" className="hidden" onChange={handleFileChange} />

          <AutocompleteTextarea
            ref={acRef}
            value={text}
            onChange={setTextAndSave}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            skills={skills}
            workspaceFiles={workspaceFiles}
            placeholder={busy ? 'Steer or queue…' : 'Message Claude…'}
            disabled={disabled}
            rows={1}
            className="w-full bg-transparent border-none outline-none resize-none text-sm py-1.5 placeholder:text-muted-foreground min-h-[28px] max-h-[200px]"
          />

          {slots.inputAdornments?.(inputCtx)}

          {busy ? (
            <div className="flex items-center gap-2">
              {text.trim() && (
                <Button
                  size="icon"
                  className="h-9 w-9 sm:h-8 sm:w-8 shrink-0 rounded-lg"
                  onClick={() => submit('steer')}
                  title="Steer (inject into current turn)"
                >
                  <SendHorizontal className="w-4 h-4" />
                </Button>
              )}
              <Button
                variant="destructive"
                size="icon"
                className="h-9 w-9 sm:h-8 sm:w-8 shrink-0 rounded-lg"
                onClick={() => onCancel()}
                title="Stop generation"
              >
                <Square className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="icon"
              className="h-9 w-9 sm:h-8 sm:w-8 shrink-0 rounded-lg"
              onClick={() => submit()}
              disabled={disabled || uploading || (!text.trim() && attachments.length === 0)}
            >
              <SendHorizontal className="w-4 h-4" />
            </Button>
          )}
        </div>

        {queue.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mt-2">
            {queue.map((q, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-950/40 px-2.5 py-1 text-xs text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-400/30">
                <span className="truncate max-w-[200px]">{q}</span>
                <button onClick={() => onRemoveQueued(i)} className="hover:text-blue-900 dark:hover:text-blue-100">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground text-center mt-2">
          {busy
            ? 'Enter to steer (redirect) · Tab to queue (after done) · Shift+Enter for newline'
            : 'Enter to send · Shift+Enter for newline · @ for skills · / for commands'}
        </p>
      </div>
    </div>
  );
});
