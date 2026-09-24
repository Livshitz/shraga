import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { MarkdownStream, codeBlock } from '@livx.cc/bare-v3/elements/markdown-stream';
import '@livx.cc/bare-v3/css';
import 'highlight.js/styles/github.css';
import './AssistantMarkdown.css';
import { NEEDS_AUTH, authedBlobUrl } from './AuthedImage';
import { useWorkspace } from '@/lib/workspaceContext';
import { useDarkMode } from '@/hooks/useDarkMode';
import { logger } from '@/lib/debug';

const log = logger.forComponent('AssistantMarkdown');

// Assistant text renders through bare-v3's MarkdownStream: finished blocks freeze, only the tail
// re-renders, and half-written syntax never flashes raw. One instance per text block, so text
// segments split by tool calls each get their own stream.

const RTL_BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH']);
// bare-v3 component roots — `not-prose` keeps Tailwind Typography off them (it would override their styles).
const B3_BLOCKS = ['b3-table-wrap', 'b3-alert', 'b3-md-code', 'b3-md-stats', 'b3-md-bars', 'b3-md-tasks'];
const IMG_CLASS = 'max-h-[80vh] max-w-full rounded-xl border object-contain cursor-pointer hover:opacity-80 transition-opacity';

const purify = DOMPurify(window);
purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (RTL_BLOCK_TAGS.has(el.tagName)) el.setAttribute('dir', 'auto');
  if (B3_BLOCKS.some((c) => el.classList?.contains(c))) el.classList.add('not-prose');
  if (el.tagName === 'A' && el.hasAttribute('href')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  if (el.tagName === 'IMG') {
    el.setAttribute('class', IMG_CLASS);
    const src = el.getAttribute('src') ?? '';
    // `/uploads/*` 401s without a bearer header — park the src; resolveImages() swaps in a blob URL.
    if (NEEDS_AUTH.test(src)) { el.setAttribute('data-authed-src', src); el.removeAttribute('src'); }
  }
});
const sanitize = (html: string) => purify.sanitize(html);

const code = (text: string, lang: string) => {
  const base = codeBlock(text, lang);
  if (!lang || !hljs.getLanguage(lang)) return base;
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  return base.replace(/<code>[\s\S]*<\/code>/, () => `<code class="hljs language-${lang}">${html}</code>`);
};

export function AssistantMarkdown({ text, streaming = false, onImageClick }: { text: string; streaming?: boolean; onImageClick?: (src: string) => void }) {
  const clean = text.replace(/\[Image #\d+\]\s*/g, '').trim();
  const ref = useRef<HTMLDivElement>(null);
  const view = useMemo(() => new MarkdownStream({ Marked, sanitize, code, images: (src) => NEEDS_AUTH.test(src) }), []);
  const shown = useRef<{ text: string; live: boolean } | null>(null);
  const blobs = useRef(new Map<string, Promise<string>>());
  const { getToken } = useWorkspace();
  const { dark } = useDarkMode();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = shown.current;
    const extends_ = !!s?.live && clean.startsWith(s.text);
    if (streaming) {
      if (!extends_) { el.replaceChildren(); view.attach(el); view.push(clean); }
      else if (clean.length > s!.text.length) view.push(clean.slice(s!.text.length));
    } else if (extends_) {
      view.push(clean.slice(s!.text.length));
      view.end();
    } else if (!s || s.text !== clean) {
      view.attach(el); // binds the Copy-button delegate; toHtml renders the settled message in one pass
      el.innerHTML = view.toHtml(clean);
    }
    shown.current = { text: clean, live: streaming };
    for (const img of el.querySelectorAll<HTMLImageElement>('img[data-authed-src]:not([src])')) {
      const src = img.dataset.authedSrc!;
      if (!blobs.current.has(src)) blobs.current.set(src, authedBlobUrl(src, getToken));
      blobs.current.get(src)!.then((url) => { img.src = url; }, (err) => log.error('image load failed:', src, err));
    }
  }, [clean, streaming, view, getToken]);

  useEffect(() => () => {
    view.detach();
    shown.current = null;
    for (const p of blobs.current.values()) p.then(URL.revokeObjectURL, () => {});
    blobs.current.clear();
  }, [view]);

  return (
    <div
      ref={ref}
      data-b3-theme={dark ? 'dark' : 'light'}
      onClick={(e) => { const t = e.target as HTMLElement; if (t instanceof HTMLImageElement && t.src) onImageClick?.(t.src); }}
      className="b3-root assistant-md bg-transparent prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none break-words min-w-0"
    />
  );
}
