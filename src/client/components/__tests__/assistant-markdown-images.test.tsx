import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceProvider } from '@/lib/workspaceContext';
import { AssistantMarkdown } from '../AssistantMarkdown';

// Only same-origin /uploads images render (via AuthedImage, a placeholder until the authed fetch
// resolves); anything else in LLM output (exfil via prompt-injected image URLs) shows alt text.
const html = (src: string) => renderToStaticMarkup(
  <WorkspaceProvider value={{ getToken: async () => null } as any}>
    <AssistantMarkdown text={`![pic](${src})`} />
  </WorkspaceProvider>,
);

describe('assistant markdown images', () => {
  test('/uploads image goes through AuthedImage', () => {
    const out = html('/uploads/a/b.png');
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain('>pic<');
  });
  for (const src of ['https://evil.example/p.png?d=x', '//evil/uploads/x', 'data:image/png;base64,AAAA', '/api/uploads/x.png']) {
    test(`blocks ${src}`, () => {
      const out = html(src);
      expect(out).not.toContain('<img');
      expect(out).not.toContain('aria-busy');
      expect(out).toContain('<span>pic</span>');
    });
  }
});
