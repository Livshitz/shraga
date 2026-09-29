import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Root, Element } from 'hast';
import type { Plugin } from 'unified';
import { Copy, Check } from 'lucide-react';
import 'highlight.js/styles/github.css';
import { AuthedImage, NEEDS_AUTH } from './AuthedImage';

// Assistant-reply markdown renderer — a replaceable seam: ChatView imports it as
// `@/components/AssistantMarkdown`, so a distribution overrides it by shipping a file at that path
// (the EE build's EE-first `@/` alias). Keep the props contract stable.

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

export interface AssistantMarkdownProps {
  text: string;
  /** This block is still streaming (a renderer may use it; this one re-renders whole). */
  streaming?: boolean;
  onImageClick?: (src: string) => void;
}

export function AssistantMarkdown({ text, onImageClick }: AssistantMarkdownProps) {
  const clean = text.replace(/\[Image #\d+\]\s*/g, '').trim();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, rehypeBidi]}
      className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:border prose-code:before:content-none prose-code:after:content-none break-words min-w-0"
      components={{
        pre: ({ children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        // Only same-origin /uploads images load; anything else in model output (exfil via a
        // prompt-injected image URL) shows its alt text instead of auto-fetching.
        img: ({ src, alt }) => src && NEEDS_AUTH.test(src)
          ? <AuthedImage src={src} alt={alt ?? ''} className="max-h-[80vh] max-w-full rounded-xl border object-contain cursor-pointer hover:opacity-80 transition-opacity" onClick={(s) => onImageClick?.(s)} />
          : <span>{alt}</span>,
      }}
    >{clean}</ReactMarkdown>
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
