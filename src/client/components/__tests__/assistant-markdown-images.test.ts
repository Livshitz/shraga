import { describe, expect, test } from 'bun:test';
import { Marked } from 'marked';
import { MarkdownStream } from '@livx.cc/bare-v3/elements/markdown-stream';
import { NEEDS_AUTH } from '../AuthedImage';

// Mirrors AssistantMarkdown's MarkdownStream options (pre-DOMPurify): only same-origin /uploads
// images render; anything else in LLM output (exfil via prompt-injected image URLs) shows alt text.
const view = new MarkdownStream({ Marked, sanitize: (h: string) => h, images: (src: string) => NEEDS_AUTH.test(src) });
const html = (src: string) => view.toHtml(`![pic](${src})`);

describe('assistant markdown images', () => {
  test('/uploads image renders an <img>', () => {
    expect(html('/uploads/a/b.png')).toContain('<img src="/uploads/a/b.png"');
  });
  for (const src of ['https://evil.example/p.png?d=x', '//evil/uploads/x', 'data:image/png;base64,AAAA', '/api/uploads/x.png']) {
    test(`blocks ${src}`, () => {
      const out = html(src);
      expect(out).not.toContain('<img');
      expect(out).toContain('pic');
    });
  }
});
