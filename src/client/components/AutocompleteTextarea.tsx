import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

type MentionKind = 'mention' | 'command';
type Suggestion = { kind: 'skill' | 'workspace'; value: string };

export interface AutocompleteTextareaHandle {
  focus: () => void;
  setValue: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  skills?: string[];
  workspaceFiles?: string[];
  placeholder?: string;
  className?: string;
  rows?: number;
  disabled?: boolean;
  autoResize?: boolean;
  maxHeight?: number;
  onPaste?: (e: React.ClipboardEvent) => void;
}

export const AutocompleteTextarea = forwardRef<AutocompleteTextareaHandle, Props>(function AutocompleteTextarea(
  { value, onChange, onKeyDown, onPaste, skills = [], workspaceFiles = [], placeholder, className, rows = 1, disabled, autoResize = true, maxHeight = 200 },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number; kind: MentionKind } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (text: string) => {
      onChange(text);
      if (autoResize) resizeTextarea();
    },
  }));

  const suggestions: Suggestion[] = mention
    ? [
        ...skills
          .filter((s) => s.toLowerCase().includes(mention.query.toLowerCase()))
          .map((s) => ({ kind: 'skill' as const, value: s })),
        ...(mention.kind === 'mention'
          ? workspaceFiles
              .filter((f) => f.toLowerCase().includes(mention.query.toLowerCase()))
              .map((f) => ({ kind: 'workspace' as const, value: f }))
          : []),
      ]
    : [];

  function resizeTextarea() {
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    }, 0);
  }

  const insertMention = (val: string) => {
    if (!mention) return;
    const prefix = mention.kind === 'command' ? '/' : '@';
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.start + mention.query.length + 1);
    const newText = `${before}${prefix}${val} ${after}`;
    onChange(newText);
    setMention(null);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      if (autoResize) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'; }
      const pos = before.length + val.length + 2;
      el.setSelectionRange(pos, pos);
      el.focus();
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(suggestions[mentionIdx].value); return; }
      if (e.key === 'Escape') { setMention(null); return; }
    }
    onKeyDown?.(e);
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    onChange(val);
    const el = e.target;
    if (autoResize) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'; }

    const cursor = el.selectionStart ?? val.length;
    const textBefore = val.slice(0, cursor);
    const slashMatch = textBefore.match(/(?:^|\n)\/([\w-]*)$/);
    const atMatch = textBefore.match(/@([\w\-./]*)$/);
    if (slashMatch) {
      setMention({ query: slashMatch[1], start: slashMatch.index! + (textBefore[slashMatch.index!] === '\n' ? 1 : 0), kind: 'command' });
      setMentionIdx(0);
    } else if (atMatch) {
      setMention({ query: atMatch[1], start: atMatch.index!, kind: 'mention' });
      setMentionIdx(0);
    } else {
      setMention(null);
    }
  };

  useEffect(() => {
    const handler = () => setMention(null);
    if (mention) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mention]);

  return (
    <div className="relative flex-1 min-w-0">
      {mention && suggestions.length > 0 && (
        <div className="absolute bottom-full mb-1 left-0 z-50 bg-background border rounded-lg shadow-lg overflow-hidden min-w-[220px] max-h-64 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={`${s.kind}:${s.value}`}
              onMouseDown={(e) => { e.preventDefault(); insertMention(s.value); }}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors flex items-center gap-2 ${i === mentionIdx ? 'bg-accent' : ''}`}
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-14">{mention?.kind === 'command' ? 'cmd' : s.kind === 'skill' ? 'skill' : 'file'}</span>
              <span className="truncate"><span className="text-muted-foreground">{mention?.kind === 'command' ? '/' : '@'}</span>{s.value}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        dir="auto"
        className={className}
      />
    </div>
  );
});
